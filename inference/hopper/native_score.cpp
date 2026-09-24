// Single-pass Hopper scorer for llama.cpp v0.4.1.
// Protocol: one line of "N token_ids... K letter_token_ids..." per request.
// Output: one line of K JSON floating-point logits and elapsed decode seconds.
#include "llama.h"
#include "ggml-backend.h"

#include <algorithm>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

int main(int argc, char ** argv) {
    if (argc != 2) {
        std::cerr << "usage: hopper-native-score MODEL.gguf\n";
        return 2;
    }
    ggml_backend_load_all();
    auto model_params = llama_model_default_params();
    model_params.n_gpu_layers = 99;
    llama_model * model = llama_model_load_from_file(argv[1], model_params);
    if (!model) return 2;
    auto params = llama_context_default_params();
    params.n_ctx = 8192;
    params.n_batch = 512;
    params.n_ubatch = 512;
    params.n_outputs_max = 1;
    params.n_threads = 4;
    params.n_threads_batch = 4;
    llama_context * ctx = llama_init_from_model(model, params);
    if (!ctx) {
        llama_model_free(model);
        return 2;
    }
    const int vocab_size = llama_vocab_n_tokens(llama_model_get_vocab(model));
    std::vector<int> expected_letters;
    for (char letter = 'A'; letter <= 'Z'; ++letter) {
        llama_token token = LLAMA_TOKEN_NULL;
        const int count = llama_tokenize(llama_model_get_vocab(model), &letter, 1,
                                         &token, 1, false, false);
        if (count != 1) {
            std::cerr << "GGUF tokenizer does not have a single-token letter " << letter << "\n";
            llama_free(ctx);
            llama_model_free(model);
            return 2;
        }
        expected_letters.push_back(token);
    }
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream input(line);
        int n = 0, k = 0;
        if (!(input >> n) || n < 1 || n > 8192) {
            std::cout << "ERR invalid_prompt_length\n" << std::flush;
            continue;
        }
        std::vector<llama_token> ids(n);
        bool valid = true;
        for (int i = 0; i < n; ++i) {
            if (!(input >> ids[i]) || ids[i] < 0 || ids[i] >= vocab_size) valid = false;
        }
        if (!(input >> k) || k < 1 || k > 26) valid = false;
        std::vector<int> letters(k > 0 && k <= 26 ? k : 0);
        for (int & id : letters) {
            if (!(input >> id) || id < 0 || id >= vocab_size) valid = false;
        }
        std::string extra;
        if (input >> extra) valid = false;
        if (!valid) {
            std::cout << "ERR invalid_tokens\n" << std::flush;
            continue;
        }
        if (!std::equal(letters.begin(), letters.end(), expected_letters.begin())) {
            std::cout << "ERR tokenizer_mismatch\n" << std::flush;
            continue;
        }
        llama_memory_clear(llama_get_memory(ctx), true);
        const auto started = std::chrono::steady_clock::now();
        int status = 0;
        for (int offset = 0; offset < n; offset += 512) {
            const int count = std::min(512, n - offset);
            auto batch = llama_batch_get_one(ids.data() + offset, count);
            status = llama_decode(ctx, batch);
            if (status != 0) break;
        }
        if (status != 0) {
            std::cout << "ERR decode_failed\n" << std::flush;
            continue;
        }
        // Synchronizes the GPU and reads only the final position. No token is generated.
        const float * logits = llama_get_logits_ith(ctx, -1);
        if (!logits) {
            std::cout << "ERR missing_logits\n" << std::flush;
            continue;
        }
        const auto seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
        std::cout << std::setprecision(9) << "{\"logits\":[";
        for (int i = 0; i < k; ++i) {
            if (i) std::cout << ',';
            std::cout << logits[letters[i]];
        }
        std::cout << "],\"forward_seconds\":" << seconds << "}\n" << std::flush;
    }
    llama_free(ctx);
    llama_model_free(model);
    return 0;
}
