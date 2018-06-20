# bitcoincore-universal-pool
Universal mining pool with support 35 hashing algoritms and more 100 coins based on this algoritms.

Supported algoritms
- sha256
- sha256d
- scrypt
- scrypt-og
- scrypt-jane
- scrypt-n
- sha1
- x11
- x11gost
- bitcore
- x13
- x15
- nist5
- quark
- keccak
- keccakc
- blake
- blake2s
- skein
- groestlmyriad
- groestl
- fugue
- shavite3
- hefty1
- whirlpoolx
- lyra2re
- lyra2re2
- lyra2z
- lyra2h
- tribus
- skunk
- jha
- qubit
- zr5
- ziftr
- hsr
- neoscrypt
- fresh

Features
- Support Stratum mining
- Support vardiff
- Support workers id
- PPLNS block reward
- JSON API for get statistic
- Html static frontend, easy for modification

Configuration
- Configuration is actually simple, just read it twice and think twice before changing defaults.
- Dev fee 1.5% of pool fee.

Dependencies:
- Ubuntu 16.04 LTS
- Redis-server
- Nodejs
- Coin daemon
- Coin rpc wallet 

Credits
- Modifed by AME Corp
- based on node-stratum-pool
