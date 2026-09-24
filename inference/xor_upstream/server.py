#!/usr/bin/env python3
"""JEV-compatible decision API on top of an SGLang backend.

Implements:
  POST /v1/systemone   {state, model, questions} -> {model, answers, usage}
  GET  /v1/models
  GET  /health

Question types (matching Jev):
  noul   {type, instructions, criteria?}                        -> {"noul": P(yes)}
  choice {type, instructions, criteria: {key: desc|null}}       -> {"choice", "probabilities", "confidence"}
  score  {type, instructions, criteria: [level descs...]}       -> {"score", "legend", "probabilities", "confidence"}

Reads first-token logprobs of single-token letter labels and renormalizes.
Stdlib only: python3 server.py [port]
"""
import json, math, os, sys, http.client, threading, time, hashlib
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor

SGLANG = os.environ.get("OPENJEV_SGLANG_URL", "http://127.0.0.1:30001")
# OpenJev backend fanout: comma-separated backend URLs (identical engines)
# => requests rotate across lanes, doubling DP capacity per wrapper.
SGLANGS = [s.strip() for s in os.environ.get("OPENJEV_SGLANG_URLS", "").split(",") if s.strip()] or [SGLANG]
# Optional BAND routing: JSON list of {max_chars: int, urls: [..]} entries, ascending.
# /generate calls route by len(state) so big docs hit the tp-cell without
# the small paths' comm tax. Anything else goes round-robin default.
def _bands():
    raw = os.environ.get("OPENJEV_ROUTES", "")
    if not raw.strip():
        return []
    try:
        return sorted(json.loads(raw), key=lambda b: b["max_chars"])
    except Exception:
        return []
BANDS = _bands()
SERVED_MODEL = os.environ.get("OPENJEV_MODEL_ID", "jev-latest")  # echoed in answers, Jev-style
BACKEND_MODEL = os.environ.get("OPENJEV_BACKEND", "Qwen/Qwen3.6-35B-A3B")  # documentation only
ALIAS = "xor"
LETTERS = [chr(ord("A") + i) for i in range(26)]
MAX_OPTIONS = len(LETTERS)
# temperature scaling fitted on BoolQ (see RESULTS.md):
#   Qwen3-4B:          T=3 (ECE 0.118 -> 0.040 held-out)
#   Qwen3.6-35B-A3B:   T=2 (ECE 0.055 -> 0.013 held-out)
TEMPERATURE = float(__import__("os").environ.get("OPENJEV_TEMP", "2.0"))
# Per-type temperatures used by the released inference configuration:
#   noul:  BoolQ   logloss 0.238, ece 0.031 @ T=2.0
#   choice: AG News logloss 0.399, ece 0.023 @ T=2.2
#   score: Yelp-5  logloss 1.026, ece 0.087 @ T=2.7
# OPENJEV_TEMP_JSON overrides ANY entry; e.g. '{\"score\": 3.0}'.
DEFAULT_TEMP_MAP = {"noul": 2.0, "choice": 2.2, "score": 2.7}
def _temp_map():
    raw = __import__("os").environ.get("OPENJEV_TEMP_JSON", "")
    if raw.strip():
        try:
            t = json.loads(raw.strip().strip('"').strip("'"))  # nested-ssh quote shedding
            return {**DEFAULT_TEMP_MAP, **{k: float(v) for k, v in t.items()}}
        except (json.JSONDecodeError, ValueError):
            pass
    return dict(DEFAULT_TEMP_MAP)
TEMP = _temp_map()

# ---------- sglang primitives ----------

_tloc = threading.local()
_lane_rr = {"i": 0}
_lane_rr_lock = threading.Lock()

def _pick_urls(state_chars):
    if not BANDS:
        return SGLANGS
    for band in BANDS:
        if state_chars <= band["max_chars"]:
            return band["urls"]
    return SGLANGS

def _conn(state_chars=0):
    urls = _pick_urls(state_chars)
    with _lane_rr_lock:
        url = urls[_lane_rr["i"] % len(urls)]
        _lane_rr["i"] += 1
    conns = getattr(_tloc, "conns", None)
    if conns is None:
        conns = _tloc.conns = {}
    if url not in conns:
        host, port = url.replace("http://", "").split(":")
        conns[url] = http.client.HTTPConnection(host, int(port), timeout=180)
    return conns[url]

def _drop_conn(c):
    conns = getattr(_tloc, "conns", None)
    if not conns:
        return
    for k, v in list(conns.items()):
        if v is c:
            del conns[k]

def _post(path, payload, state_chars=0):
    body = json.dumps(payload)
    for attempt in (1, 2):
        c = None
        try:
            c = _conn(state_chars)
            c.request("POST", path, body, {"Content-Type": "application/json"})
            r = c.getresponse()
            data = r.read()
            if r.status != 200:
                raise RuntimeError(f"sglang {r.status}: {data[:300]!r}")
            return json.loads(data)
        except (http.client.HTTPException, ConnectionError, OSError):
            if c is not None:
                _drop_conn(c)
            if attempt == 2:
                raise

_LABEL_IDS = {}   # {backend_model_path: [ids...]} — cache per backend; backend swaps must not corrupt ids

_BACKEND_KEY_CACHE = {}
def _backend_key():
    """model_path from /model_info; memoized per (url) — engine + backend swap on
    this port under restart is discovered through the wrapper's restart cycle."""
    u = SGLANG
    if u in _BACKEND_KEY_CACHE:
        return _BACKEND_KEY_CACHE[u]
    try:
        c = _conn()
        c.request("GET", "/model_info", "")
        r = c.getresponse()
        data = r.read()
        r.close()
        key = json.loads(data).get("model_path", "?") or "?"
    except Exception:
        key = "?"
    _BACKEND_KEY_CACHE[u] = key
    return key

def label_ids():
    key = _backend_key()
    if key not in _LABEL_IDS:
        ids = []
        for l in LETTERS:
            d = _post("/tokenize", {"prompt": f" {l}", "add_special_tokens": False})
            toks = d["tokens"] if isinstance(d, dict) else d
            assert len(toks) == 1, f"label {l} not single token: {toks}"
            ids.append(toks[0]["id"] if isinstance(toks[0], dict) else toks[0])
        _LABEL_IDS[key] = ids
    return _LABEL_IDS[key]

IMAGES = os.environ.get("OPENJEV_IMAGES", "0") == "1"

def read_options_batch(state, jobs, images=None):
    """ONE /generate call carrying all questions of a request: SGLang batches the
    prefill (radix hits on the shared state prefix) and the wrapper pays only 1
    HTTP round-trip. jobs = [(question_text, option_descs)].
    Returns [(probs, raw_lp_map, prompt_tokens) per job]."""
    # Every question goes in TWICE: forward (A=yes,B=...) and reversed letter
    # order. Merging the two softmax vectors removes letter-position bias
    # structurally (temperature scaling only patches its symptom).
    variants = []  # (qtext, descs in display order, letter labels, job_index)
    for ji, (qtext, descs, qtype) in enumerate(jobs):
        for flip in (False, True):
            d = list(reversed(descs)) if flip else list(descs)
            variants.append((qtext, d, LETTERS[:len(d)], ji))
    if images and IMAGES:
        prompts = [
            "<|im_start|>system\nYou are a careful classifier that can read images.<|im_end|>\n"
            f"<|im_start|>user\n{'<|vision_start|><|image_pad|><|vision_end|>' * len(images)}"
            f"{state}\n\n{qtext}\n\nOptions:\n"
            + "\n".join(f"{l}: {dd}" for l, dd in zip(labels, d))
            + "\n\nAnswer with a single letter only."
            + "<|im_end|>\n<|im_start|>assistant\nAnswer:\n"
            for qtext, d, labels, _ in variants
        ]
    else:
        prompts = [
            "<|im_start|>system\nYou are a careful classifier.<|im_end|>\n"
            f"<|im_start|>user\n{state}\n\n{qtext}\n\nOptions:\n"
            + "\n".join(f"{l}: {dd}" for l, dd in zip(labels, d))
            + "\n\nAnswer with a single letter only."
            + "<|im_end|>\n<|im_start|>assistant\nAnswer:\n"
            for qtext, d, labels, _ in variants
        ]
    payload = {
        "text": prompts,
        "sampling_params": {"max_new_tokens": 1, "temperature": 0.0},
        "return_logprob": [True] * len(variants),
        "token_ids_logprob": [label_ids()[:len(d)] for _, d, _, _ in variants],
        "logprob_start_len": [-1] * len(variants)}
    if images and IMAGES:
        payload["image_data"] = [list(images)] * len(variants)
    outs = _post("/generate", state_chars=len(state), payload=payload)
    if isinstance(outs, dict):  # single-item batch returns dict in some builds
        outs = [outs]
    results = []
    for i in range(0, len(variants), 2):
        pair = outs[i:i + 2]
        (qtext_f, descs, labels_f, ji), (_, _, _, _) = variants[i], variants[i + 1]
        T = TEMP.get(jobs[ji][2], TEMPERATURE)
        pair_lp = []
        for out in pair:
            lp = {}
            for position in out["meta_info"].get("output_token_ids_logprobs") or []:
                for logp, tid, _ in position:
                    tid = int(tid)
                    # SGLang returns null for vanishingly unlikely tokens: treat as
                    # negligible mass (ln p ≈ -30 ≈ 1e-13) rather than crashing.
                    lp[tid] = logp if logp is not None else -30.0
            pair_lp.append(lp)
        ids = label_ids()[:len(descs)]
        def probs(lp):
            vals = [lp[t] for t in ids]
            m = max(vals)
            exps = [math.e ** ((v - m) / T) for v in vals]
            s = sum(exps)
            return [e / s for e in exps]
        if len(descs) >= 3:
            # multi-way: average RAW logprobs first, softmax ONCE at T=1.5
            lp_f = [pair_lp[0][t] for t in ids]
            lp_r = list(reversed([pair_lp[1][t] for t in ids]))
            lpa = [(a + b) / 2 for a, b in zip(lp_f, lp_r)]
            m = max(lpa)
            exps = [math.e ** ((v - m) / 1.5) for v in lpa]
            zs = sum(exps)
            probs_out = [e / zs for e in exps]
        else:
            # binary - temperature-softened each reading, then average (positional bias cancelled)
            p_f = probs(pair_lp[0])                       # forward order
            p_r = list(reversed(probs(pair_lp[1])))       # flip reverse-order probs back
            avg = [(a + b) / 2 for a, b in zip(p_f, p_r)]
            s = sum(avg)
            probs_out = [p / s for p in avg]
        raw_lp = {}
        for j, l in enumerate(labels_f):
            raw_lp[l] = math.log(probs_out[j] + 1e-13)
        results.append((probs_out, raw_lp, pair[0]["meta_info"]["prompt_tokens"]))
    return results

# ---------- jev types ----------

def confidence(probs):
    if len(probs) < 2:
        return 1.0
    h = -sum(p * math.log(p) for p in probs if p > 0)
    return max(0.0, min(1.0, 1.0 - h / math.log(len(probs))))

UNK_DESC_DEFAULT = "There is not enough information in the text to answer this question."

def _unk_spec(q):
    """Normalize a question's "unknown" field.
    true | str-description | {"key","description","threshold"} -> dict or None."""
    u = q.get("unknown")
    if not u:
        return None
    if u is True:
        return {"key": "unknown", "description": UNK_DESC_DEFAULT, "threshold": 0.5}
    if isinstance(u, str):
        return {"key": "unknown", "description": u, "threshold": 0.5}
    if isinstance(u, dict):
        return {"key": u.get("key", "unknown"),
                "description": u.get("description", UNK_DESC_DEFAULT),
                "threshold": float(u.get("threshold", 0.5))}
    return None

def prep_noul(q):
    crit = q.get("criteria") or {}
    yes = crit.get("true", "yes") or "yes"
    no = crit.get("false", "no") or "no"
    return q["instructions"], [yes, no], lambda probs: (
        {"type": "noul", "noul": round(probs[0], 4)})

def prep_choice(q):
    items = list(q["criteria"].items())
    keys = [k for k, _ in items]
    descs = [d if d is not None else k for k, d in items]
    unk = _unk_spec(q)
    if unk:
        keys.append(unk["key"])
        descs.append(unk["description"])
    def finish(probs):
        idx = probs.index(max(probs))
        out = {"type": "choice",
               "choice": keys[idx],
               "probabilities": {k: round(p, 4) for k, p in zip(keys, probs)},
               "confidence": round(confidence(probs), 4)}
        if unk and idx == len(keys) - 1:
            out["unknown"] = True
        return out
    return q["instructions"], descs, finish

def prep_score(q):
    levels = list(q["criteria"])
    unk = _unk_spec(q)
    def finish(probs):
        return {"type": "score",
                "score": round(sum(i * p for i, p in enumerate(probs)), 4),
                "legend": {str(i): lv for i, lv in enumerate(levels)},
                "probabilities": {str(i): round(p, 4) for i, p in enumerate(probs)},
                "confidence": round(confidence(probs), 4)}
    return q["instructions"], levels, finish

PREP = {"noul": prep_noul, "choice": prep_choice, "score": prep_score}

def render_state(state):
    if isinstance(state, str):
        return state
    msgs = state.get("messages") if isinstance(state, dict) else state
    if isinstance(msgs, list) and all(isinstance(m, dict) and "role" in m for m in msgs):
        return "\n".join(f"{m['role'].upper()}: {m['content']}" for m in msgs)
    return json.dumps(state, indent=2)

# ---------- http ----------

_stats_lock = threading.Lock()
_stats = {"engine_ms": [], "total_ms": [], "pre_ms": [], "post_ms": [], "n": 0}

# ---------- deterministic readout memo (opt-in: OPENJEV_CACHE=1) ----------
CACHE = os.environ.get("OPENJEV_CACHE", "0") == "1"
CACHE_MAX = int(os.environ.get("OPENJEV_CACHE_MAX", "2048"))
REQSIG = os.environ.get("OPENJEV_REQSIG", "")  # filename to log request signatures
_cache = OrderedDict()
_cache_lock = threading.Lock()
_cache_hist = {"hits": 0, "misses": 0}

def _cache_key(state, questions, images=None):
    canon = json.dumps({"s": state, "q": questions, "i": images}, sort_keys=True).encode()
    return hashlib.sha256(canon + json.dumps(TEMP, sort_keys=True).encode()
                          + SERVED_MODEL.encode() + _backend_key().encode()).hexdigest()

def _cache_get(k):
    with _cache_lock:
        v = _cache.get(k)
        if v is not None:
            _cache.move_to_end(k)
            _cache_hist["hits"] += 1
        else:
            _cache_hist["misses"] += 1
        return v

def _cache_put(k, v):
    with _cache_lock:
        _cache[k] = v
        _cache.move_to_end(k)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)

_reqsig_lock = threading.Lock()

def _reqsig(state, questions, in_tokens, total_ms, engine_ms, cache_hit):
    """One-line traffic signature: ts_ms shash16 qhash16 nq in_tok ms engine cached.
    Env-gated (OPENJEV_REQSIG=<path>), no `state` content ever written."""
    if not REQSIG:
        return
    shash = hashlib.sha256(state.encode()).hexdigest()[:16]
    qhash = hashlib.sha256(
        json.dumps(sorted(questions.keys())).encode()).hexdigest()[:16]
    line = (f"{int(time.time() * 1000)} {shash} {qhash} "
            f"{len(questions)} {in_tokens} {total_ms:.0f} {engine_ms:.0f} "
            f"{int(bool(cache_hit))}\n")
    with _reqsig_lock:
        try:
            with open(REQSIG, "a") as f:
                f.write(line)
        except OSError:
            pass

def _record(engine_ms, total_ms, pre_ms, post_ms):
    with _stats_lock:
        _stats["n"] += 1
        for k, v in (("engine_ms", engine_ms), ("total_ms", total_ms),
                     ("pre_ms", pre_ms), ("post_ms", post_ms)):
            arr = _stats[k]
            arr.append(v)
            if len(arr) > 256:
                del arr[:128]

def _stats_snapshot():
    with _stats_lock:
        import statistics as st
        out = {"n": _stats["n"]}
        if CACHE:
            with _cache_lock:
                out["cache"] = {"enabled": True, "size": len(_cache),
                                "hits": _cache_hist["hits"],
                                "misses": _cache_hist["misses"]}
        for k in ("engine_ms", "total_ms", "pre_ms", "post_ms"):
            arr = _stats[k]
            if arr:
                out[k + "_ema"] = round(sum(arr) / len(arr), 2)
                out[k + "_max"] = round(max(arr), 2)
        return out

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive for pooled clients

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        rid = hashlib.sha256(str(time.time()).encode()).hexdigest()[:24]
        self.send_header("x-request-id", rid)
        self.send_header("x-typesafe-request-id", rid)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        elif self.path == "/stats":
            self._send(200, _stats_snapshot())
        elif self.path == "/v1/models":
            self._send(200, {"data": [
                {"id": ALIAS, "underlying": SERVED_MODEL, "aliases": [SERVED_MODEL]}],
                "models": [{"name": SERVED_MODEL,
                            "description": "General-purpose system-one model.",
                            "release_date": "2026-09-08"}]})
        else:
            self._send(404, {"error": "not found"})

    def _eval_questions(self, state, questions, images=None):
        """Shared evaluation path used by /v1/systemone, /permute, /separate.
        Returns (answers: {qid: answer}, input_tokens)."""
        jobs, finishers, order = [], [], []
        abstain = {}  # qid -> min_confidence
        meta = {}     # job_index of the meta-question -> (qid, threshold)
        for qid, q in questions.items():
            t = q["type"]
            if t not in PREP:
                raise ValueError(f"{qid}: unknown question type: {t}")
            if t == "choice" and not isinstance(q.get("criteria"), dict):
                raise ValueError(f"{qid}: choice criteria must be a map")
            if t == "score" and not isinstance(q.get("criteria"), list):
                raise ValueError(f"{qid}: score criteria must be a list")
            if t in ("choice", "score"):
                n = len(q["criteria"])
                if not 2 <= n <= MAX_OPTIONS:
                    raise ValueError(f"{qid}: 2..{MAX_OPTIONS} options, got {n}")
            qtext, descs, finisher = PREP[t](q)
            jobs.append((qtext, descs, t))
            finishers.append(finisher)
            order.append(qid)
            ab = q.get("abstain")
            if isinstance(ab, dict) and isinstance(ab.get("min_confidence"), (int, float)):
                abstain[qid] = float(ab["min_confidence"])
            # noul/score unknown-detection: companion answerability question
            unk = _unk_spec(q)
            if unk and t in ("noul", "score"):
                meta_q = (f"Can the question \"{q['instructions']}\" be answered "
                          "using only the text above, without outside knowledge?")
                jobs.append((meta_q, ["yes, the text contains the answer",
                                      "no, the text does not contain the answer"], "noul"))
                meta[len(jobs) - 1] = (qid, unk["threshold"])
        _te = time.time()
        results = read_options_batch(state, jobs, images)  # ONE batched prefill+decode
        self._engine_ms_accum = getattr(self, "_engine_ms_accum", 0.0) + \
            (time.time() - _te) * 1000
        answers, in_total = {}, 0
        for qi, (qid, finisher) in enumerate(zip(order, finishers)):
            probs, _lp, tok = results[qi]  # question jobs come first, in order
            answers[qid] = finisher(probs)
            in_total += tok
            if qid in abstain:
                # no-confidence answer: decision stays, but marked unfit to act on
                if answers[qid].get("confidence", 1.0) < abstain[qid]:
                    answers[qid]["abstain"] = True
        # meta-question results live at job indices >= len(order)
        for jidx, (qid, threshold) in meta.items():
            probs, _lp, _tok = results[jidx]
            if probs[1] >= threshold:  # P(text does not contain the answer)
                answers[qid]["unknown"] = True
        return answers, in_total

    def do_POST(self):
        try:
            cl = int(self.headers.get("Content-Length", "0"))
            if cl > 8 * 1024 * 1024:
                raise ValueError("request body exceeds 8MB")
            body = json.loads(self.rfile.read(cl))
            self._t_start = time.time()
            state = render_state(body["state"])
            if len(state) > 4 * 1024 * 1024:
                raise ValueError("state exceeds 4MB")
            questions = body["questions"]
            images = body.get("images") if IMAGES else None
            if images is not None:
                if not isinstance(images, list) or not images:
                    raise ValueError("images must be a non-empty list of URL or data-URL strings")
                if len(images) > 8:
                    raise ValueError("images supports at most 8 items")
                invalid_image = any(
                    not isinstance(image, str) or not image.startswith(("http://", "https://", "data:image/"))
                    for image in images
                )
                if invalid_image:
                    raise ValueError("each image must be an HTTP(S) URL or image data URL")
            if not isinstance(questions, dict) or not questions:
                raise ValueError("questions must be a non-empty map")

            if self.path == "/v1/systemone":
                _t0 = time.time()
                ck = _cache_key(state, questions, images) if CACHE else None
                cached = _cache_get(ck) if ck else None
                if cached is not None:
                    resp = dict(cached)
                    resp["cached"] = True
                    self._send(200, resp)
                    _record(0.0, (time.time() - _t0) * 1000, 0.0, 0.0)
                    _reqsig(state, questions, 0, (time.time() - _t0) * 1000, 0.0, True)
                    return
                answers, in_total = self._eval_questions(state, questions, images)
                _t_engine = getattr(self, "_engine_ms_accum", 0.0)
                self._engine_ms_accum = 0.0
                _t1 = time.time()
                resp = {"model": SERVED_MODEL, "answers": answers,
                        "usage": {"input_tokens": in_total,
                                  "output_tokens": len(questions)}}
                if ck:
                    _cache_put(ck, resp)
                self._send(200, resp)
                _t2 = time.time()
                _record(_t_engine, (_t2 - _t0) * 1000,
                        (_t0 - getattr(self, "_t_start", _t0)) * 1000,
                        (_t2 - _t1) * 1000)
                _reqsig(state, questions, in_total, (_t2 - _t0) * 1000,
                        _t_engine, False)
            elif self.path == "/v1/systemone/permute":
                # re-ask the request under N deterministic option orders, per request
                # K questions! premise: probe-only; response carries argmax vote.
                N = max(2, min(8, int(body.get("n_permutations", 4))))
                permuted_answers = []
                import itertools
                for k in range(N):
                    qs = {}
                    for qid, q in questions.items():
                        t = q["type"]
                        if t in ("choice", "score"):
                            qq = dict(q)
                            if t == "choice":
                                items = list(qq["criteria"].items())
                                items = items[k % len(items):] + items[:k % len(items)]
                                qq["criteria"] = dict(items)
                            else:
                                c = list(qq["criteria"])
                                qq["criteria"] = list(reversed(c))
                        else:
                            qq = q
                        qs[qid] = qq
                    answers, _ = self._eval_questions(state, qs, images)
                    permuted_answers.append(answers)
                votes = {}
                for qid in questions:
                    cands = [pa[qid].get("choice") or pa[qid].get("noul") or pa[qid].get("score")
                             for pa in permuted_answers]
                    votes[qid] = {"unique_answers": len(set(map(str, cands))), "candidates": cands}
                self._send(200, {"model": SERVED_MODEL, "permutations": permuted_answers,
                                 "vote_summary": votes})
            elif self.path == "/v1/systemone/separate":
                # each question in its OWN request, no batching; debug reference
                out = {}
                for qid, q in questions.items():
                    answers, tok = self._eval_questions(state, {qid: q}, images)
                    out[qid] = {"answers": answers[qid], "input_tokens": tok}
                self._send(200, {"model": SERVED_MODEL, "separate": out})
            else:
                self._send(404, {"error": "not found"})
        except (KeyError, ValueError, AssertionError) as e:
            self._send(422, {"error": str(e)})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 30002
    print(f"mini_jev_server on :{port} -> {SGLANGS}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
