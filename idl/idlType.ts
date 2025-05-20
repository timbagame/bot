/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/coinflip.json`.
 */
export type Coinflip = {
  "address": "DNAGhpeMXvdCkwTYKmuJfcwpu4sJpegcnHnHih1Y3Gzi",
  "metadata": {
    "name": "coinflip",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelGame",
      "discriminator": [
        121,
        194,
        154,
        118,
        103,
        235,
        149,
        52
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "playerBalance",
          "writable": true
        },
        {
          "name": "oracle"
        },
        {
          "name": "gameToken"
        },
        {
          "name": "gameVault"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "gameTokenAccount",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claimFee",
      "discriminator": [
        169,
        32,
        79,
        137,
        136,
        232,
        70,
        137
      ],
      "accounts": [
        {
          "name": "gameToken",
          "writable": true
        },
        {
          "name": "gameVault"
        },
        {
          "name": "oracle",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "authorityTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "authority"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "game_token.token_mint",
                "account": "gameToken"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "gameTokenAccount",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        }
      ],
      "args": []
    },
    {
      "name": "claimWin",
      "discriminator": [
        163,
        215,
        101,
        246,
        25,
        134,
        110,
        194
      ],
      "accounts": [
        {
          "name": "playerBalance",
          "writable": true
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "gameToken"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "gameTokenAccount",
          "writable": true
        },
        {
          "name": "gameVault"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "completeGame",
      "discriminator": [
        105,
        69,
        184,
        5,
        143,
        182,
        92,
        132
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "oracle"
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "playerBalance",
          "writable": true
        },
        {
          "name": "gameToken"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "secretKey",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        }
      ]
    },
    {
      "name": "initializeGame",
      "discriminator": [
        44,
        62,
        102,
        247,
        126,
        208,
        130,
        215
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "randomHash"
              }
            ]
          }
        },
        {
          "name": "player",
          "writable": true,
          "signer": true
        },
        {
          "name": "playerBalance",
          "writable": true
        },
        {
          "name": "oracle",
          "writable": true
        },
        {
          "name": "gameToken"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "gameTokenAccount",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "gameType",
          "type": {
            "defined": {
              "name": "gameType"
            }
          }
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "maxPlayers",
          "type": "u16"
        },
        {
          "name": "minPlayers",
          "type": "u16"
        },
        {
          "name": "timeout",
          "type": "u32"
        },
        {
          "name": "isPrivate",
          "type": "bool"
        },
        {
          "name": "randomHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initializeOracle",
      "discriminator": [
        144,
        223,
        131,
        120,
        196,
        253,
        181,
        99
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feePercentage",
          "type": "u8"
        },
        {
          "name": "oracleBufferTime",
          "type": "u16"
        },
        {
          "name": "maxPlayers",
          "type": "u16"
        },
        {
          "name": "maxTimeout",
          "type": "u32"
        },
        {
          "name": "minTimeout",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initializePlayerBalance",
      "discriminator": [
        193,
        86,
        175,
        197,
        130,
        49,
        234,
        91
      ],
      "accounts": [
        {
          "name": "playerBalance",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "player"
              },
              {
                "kind": "account",
                "path": "game_token.token_mint",
                "account": "gameToken"
              }
            ]
          }
        },
        {
          "name": "gameToken"
        },
        {
          "name": "playerTokenAccount",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "player"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "game_token.token_mint",
                "account": "gameToken"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "player",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeToken",
      "discriminator": [
        38,
        209,
        150,
        50,
        190,
        117,
        16,
        54
      ],
      "accounts": [
        {
          "name": "gameToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ]
          }
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "gameVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ]
          }
        },
        {
          "name": "gameTokenAccount",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "gameVault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "tokenMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "oracle"
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        }
      ],
      "args": [
        {
          "name": "ticker",
          "type": "string"
        },
        {
          "name": "minAmount",
          "type": "u64"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "joinGame",
      "discriminator": [
        107,
        112,
        18,
        38,
        56,
        173,
        60,
        128
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "playerBalance",
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "optional": true
        },
        {
          "name": "gameToken"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "gameTokenAccount",
          "writable": true
        },
        {
          "name": "oracle"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "unjoinGame",
      "discriminator": [
        105,
        123,
        174,
        143,
        207,
        2,
        17,
        206
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "gameToken"
        },
        {
          "name": "playerBalance",
          "writable": true
        },
        {
          "name": "gameVault"
        },
        {
          "name": "playerTokenAccount",
          "writable": true
        },
        {
          "name": "gameTokenAccount",
          "writable": true
        },
        {
          "name": "oracle"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "updateOracle",
      "discriminator": [
        112,
        41,
        209,
        18,
        248,
        226,
        252,
        188
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true
        },
        {
          "name": "oldAuthority",
          "signer": true
        },
        {
          "name": "newAuthority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "feePercentage",
          "type": "u8"
        },
        {
          "name": "oracleBufferTime",
          "type": "u16"
        },
        {
          "name": "maxPlayers",
          "type": "u16"
        },
        {
          "name": "maxTimeout",
          "type": "u32"
        },
        {
          "name": "minTimeout",
          "type": "u32"
        }
      ]
    },
    {
      "name": "updateToken",
      "discriminator": [
        92,
        200,
        25,
        239,
        138,
        254,
        58,
        102
      ],
      "accounts": [
        {
          "name": "gameToken",
          "writable": true
        },
        {
          "name": "oracle"
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "ticker",
          "type": "string"
        },
        {
          "name": "minAmount",
          "type": "u64"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "game",
      "discriminator": [
        27,
        90,
        166,
        125,
        74,
        100,
        121,
        18
      ]
    },
    {
      "name": "gameToken",
      "discriminator": [
        146,
        160,
        167,
        120,
        232,
        217,
        240,
        63
      ]
    },
    {
      "name": "oracle",
      "discriminator": [
        139,
        194,
        131,
        179,
        140,
        179,
        229,
        244
      ]
    },
    {
      "name": "playerBalance",
      "discriminator": [
        244,
        128,
        24,
        93,
        212,
        190,
        202,
        111
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "gameFull",
      "msg": "Game already full"
    },
    {
      "code": 6001,
      "name": "alreadyJoined",
      "msg": "Player already joined"
    },
    {
      "code": 6002,
      "name": "gameReadyForOracle",
      "msg": "Game ready for oracle"
    },
    {
      "code": 6003,
      "name": "gameNotReadyForOracle",
      "msg": "Game not ready for oracle"
    },
    {
      "code": 6004,
      "name": "invalidSecretKey",
      "msg": "Invalid secret key"
    },
    {
      "code": 6005,
      "name": "invalidVault",
      "msg": "Invalid vault"
    },
    {
      "code": 6006,
      "name": "invalidPlayersCount",
      "msg": "Invalid players count"
    },
    {
      "code": 6007,
      "name": "gameNotActive",
      "msg": "Game not active"
    },
    {
      "code": 6008,
      "name": "gameCompleted",
      "msg": "Game completed"
    },
    {
      "code": 6009,
      "name": "invalidTimeout",
      "msg": "Invalid timeout"
    },
    {
      "code": 6010,
      "name": "invalidToken",
      "msg": "Invalid token"
    },
    {
      "code": 6011,
      "name": "insufficientBalance",
      "msg": "Insufficient balance"
    },
    {
      "code": 6012,
      "name": "unauthorizedPlayer",
      "msg": "Unauthorized player"
    },
    {
      "code": 6013,
      "name": "unauthorizedAuthority",
      "msg": "Unauthorized authority"
    },
    {
      "code": 6014,
      "name": "tokenNotEnabled",
      "msg": "Token not enabled"
    },
    {
      "code": 6015,
      "name": "invalidAmount",
      "msg": "Invalid amount"
    }
  ],
  "types": [
    {
      "name": "game",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "gameType",
            "type": {
              "defined": {
                "name": "gameType"
              }
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "maxPlayers",
            "type": "u16"
          },
          {
            "name": "minPlayers",
            "type": "u16"
          },
          {
            "name": "players",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "winner",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "gameStatus"
              }
            }
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "type": "u64"
          },
          {
            "name": "timeout",
            "type": "u32"
          },
          {
            "name": "isPrivate",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "gameStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "completed"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "gameToken",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "gameTokenAccount",
            "type": "pubkey"
          },
          {
            "name": "gameVault",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "minAmount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "gameType",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "coinflip"
          },
          {
            "name": "giveaway"
          }
        ]
      }
    },
    {
      "name": "oracle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "feePercentage",
            "type": "u8"
          },
          {
            "name": "oracleBufferTime",
            "type": "u16"
          },
          {
            "name": "maxPlayers",
            "type": "u16"
          },
          {
            "name": "maxTimeout",
            "type": "u32"
          },
          {
            "name": "minTimeout",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "playerBalance",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "playerTokenAccount",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
