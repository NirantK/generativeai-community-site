# Pinned Xor serving wrapper

`server.py`, `smoke_test.py`, and the license notices are copied without changes
from `juspay/xor` revision `679decd4c669e5c37f4ac29dbd9957997424c876`,
inside `serving/xor-serving.tar.gz`. The release bundle SHA-256 is
`0a63473caaa3c6bfc8bc15fbab62f0a9a84c7ebf4ab6e06d0699891b7be6159b`.

The release's wrapper performs the candidate-token readout, forward and reverse
option order evaluation, and per-question probability calibration. Keep it pinned
when changing GPU hardware or serving settings so results remain comparable.
