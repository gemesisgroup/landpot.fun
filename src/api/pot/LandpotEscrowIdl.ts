/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/landpot_escrow.json`.
 */
export type LandpotEscrow = {
  address: "4cbs4ZSsC9E9S56QwoAxPKDPDjRbfWzoUso3R8NWq165";
  metadata: {
    name: "landpotEscrow";
    version: "0.1.0";
    spec: "0.1.0";
    description: "Landpot pot escrow (docs/LandpotPot.md)";
  };
  instructions: [
    {
      name: "cancel";
      discriminator: [232, 219, 223, 41, 219, 236, 220, 190];
      accounts: [
        {
          name: "authority";
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
      ];
      args: [];
    },
    {
      name: "claim";
      discriminator: [62, 198, 214, 193, 213, 159, 108, 210];
      accounts: [
        {
          name: "player";
          writable: true;
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
        {
          name: "mint";
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "round";
              },
            ];
          };
        },
        {
          name: "to";
          writable: true;
        },
        {
          name: "cap";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 97, 112];
              },
              {
                kind: "account";
                path: "player";
              },
            ];
          };
        },
        {
          name: "tokenProgram";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [];
    },
    {
      name: "closeRound";
      docs: [
        "Closes a settled round once nothing is left to claim; the rent of the",
        "round and its vault goes back to the operator, who paid it.",
      ];
      discriminator: [149, 14, 81, 88, 230, 226, 234, 37];
      accounts: [
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "round";
              },
            ];
          };
        },
        {
          name: "operator";
          writable: true;
        },
        {
          name: "tokenProgram";
        },
      ];
      args: [];
    },
    {
      name: "deposit";
      discriminator: [242, 35, 198, 137, 82, 225, 242, 182];
      accounts: [
        {
          name: "player";
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
        {
          name: "mint";
        },
        {
          name: "from";
          writable: true;
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "round";
              },
            ];
          };
        },
        {
          name: "tokenProgram";
        },
      ];
      args: [];
    },
    {
      name: "finalize";
      discriminator: [171, 61, 218, 56, 127, 115, 12, 217];
      accounts: [
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
        {
          name: "mint";
          writable: true;
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "round";
              },
            ];
          };
        },
        {
          name: "treasuryAccount";
          writable: true;
        },
        {
          name: "tokenProgram";
        },
      ];
      args: [];
    },
    {
      name: "initialize";
      discriminator: [175, 175, 109, 31, 13, 152, 155, 237];
      accounts: [
        {
          name: "authority";
          writable: true;
          signer: true;
        },
        {
          name: "config";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "mint";
        },
        {
          name: "tokenProgram";
        },
        {
          name: "program";
          address: "4cbs4ZSsC9E9S56QwoAxPKDPDjRbfWzoUso3R8NWq165";
        },
        {
          name: "programData";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "args";
          type: {
            defined: {
              name: "initArgs";
            };
          };
        },
      ];
    },
    {
      name: "open";
      discriminator: [228, 220, 155, 71, 199, 189, 60, 45];
      accounts: [
        {
          name: "operator";
          writable: true;
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "arg";
                path: "roundId";
              },
            ];
          };
        },
        {
          name: "mint";
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "round";
              },
            ];
          };
        },
        {
          name: "tokenProgram";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "roundId";
          type: {
            array: ["u8", 32];
          };
        },
        {
          name: "stake";
          type: "u64";
        },
        {
          name: "minPlayers";
          type: "u8";
        },
        {
          name: "maxPlayers";
          type: "u8";
        },
        {
          name: "fundingEnds";
          type: "i64";
        },
        {
          name: "resultEnds";
          type: "i64";
        },
      ];
    },
    {
      name: "propose";
      docs: [
        "The oracle's split of the net pot, one amount per depositor in",
        "deposit order. It signs this transaction itself.",
      ];
      discriminator: [93, 253, 82, 168, 118, 33, 102, 90];
      accounts: [
        {
          name: "oracle";
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "amounts";
          type: {
            vec: "u64";
          };
        },
        {
          name: "replayHash";
          type: {
            array: ["u8", 32];
          };
        },
      ];
    },
    {
      name: "review";
      discriminator: [197, 248, 119, 131, 129, 157, 250, 147];
      accounts: [
        {
          name: "guardian";
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "freeze";
          type: "bool";
        },
      ];
    },
    {
      name: "setPaused";
      discriminator: [91, 60, 125, 192, 176, 225, 166, 218];
      accounts: [
        {
          name: "guardian";
          signer: true;
        },
        {
          name: "config";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "paused";
          type: "bool";
        },
      ];
    },
    {
      name: "start";
      discriminator: [62, 15, 117, 236, 47, 1, 89, 139];
      accounts: [
        {
          name: "operator";
          signer: true;
        },
        {
          name: "config";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 102, 105, 103];
              },
            ];
          };
        },
        {
          name: "round";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [114, 111, 117, 110, 100];
              },
              {
                kind: "account";
                path: "round.id";
                account: "round";
              },
            ];
          };
        },
      ];
      args: [];
    },
  ];
  accounts: [
    {
      name: "claimCap";
      discriminator: [75, 4, 100, 226, 119, 178, 186, 228];
    },
    {
      name: "config";
      discriminator: [155, 12, 170, 224, 30, 250, 204, 130];
    },
    {
      name: "round";
      discriminator: [87, 127, 165, 51, 73, 78, 116, 174];
    },
  ];
  events: [
    {
      name: "claimed";
      discriminator: [217, 192, 123, 72, 108, 150, 248, 33];
    },
    {
      name: "deposited";
      discriminator: [111, 141, 26, 45, 161, 35, 100, 57];
    },
    {
      name: "finalized";
      discriminator: [4, 77, 242, 80, 20, 152, 247, 252];
    },
    {
      name: "opened";
      discriminator: [166, 172, 97, 9, 77, 76, 189, 109];
    },
    {
      name: "paused";
      discriminator: [172, 248, 5, 253, 49, 255, 255, 232];
    },
    {
      name: "proposed";
      discriminator: [216, 37, 138, 141, 130, 208, 180, 153];
    },
    {
      name: "refunding";
      discriminator: [104, 12, 84, 203, 117, 153, 49, 161];
    },
    {
      name: "reviewed";
      discriminator: [170, 67, 152, 86, 116, 105, 139, 50];
    },
    {
      name: "started";
      discriminator: [56, 221, 130, 183, 11, 167, 161, 254];
    },
  ];
  errors: [
    {
      code: 6000;
      name: "unauthorized";
      msg: "not allowed for this signer";
    },
    {
      code: 6001;
      name: "invalidInput";
      msg: "invalid input";
    },
    {
      code: 6002;
      name: "wrongPhase";
      msg: "not in this phase";
    },
    {
      code: 6003;
      name: "limitExceeded";
      msg: "limit reached or nothing to claim";
    },
    {
      code: 6004;
      name: "transferFailed";
      msg: "the vault did not receive the full amount";
    },
    {
      code: 6005;
      name: "badMint";
      msg: "mint not supported: freeze authority or a disallowed extension";
    },
  ];
  types: [
    {
      name: "claimCap";
      docs: [
        "What a wallet has claimed today, for the daily cap. One per wallet,",
        "reset when the day changes.",
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "day";
            type: "i64";
          },
          {
            name: "paid";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "claimed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "player";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "config";
      type: {
        kind: "struct";
        fields: [
          {
            name: "guardian";
            type: "pubkey";
          },
          {
            name: "operator";
            type: "pubkey";
          },
          {
            name: "oracle";
            type: "pubkey";
          },
          {
            name: "treasury";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "tokenProgram";
            type: "pubkey";
          },
          {
            name: "decimals";
            type: "u8";
          },
          {
            name: "burnBps";
            type: "u16";
          },
          {
            name: "treasuryBps";
            type: "u16";
          },
          {
            name: "reviewDelay";
            type: "i64";
          },
          {
            name: "maxBank";
            type: "u64";
          },
          {
            name: "dailyCap";
            type: "u64";
          },
          {
            name: "paused";
            type: "bool";
          },
          {
            name: "bump";
            type: "u8";
          },
        ];
      };
    },
    {
      name: "deposited";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "player";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "finalized";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
        ];
      };
    },
    {
      name: "initArgs";
      type: {
        kind: "struct";
        fields: [
          {
            name: "guardian";
            type: "pubkey";
          },
          {
            name: "operator";
            type: "pubkey";
          },
          {
            name: "oracle";
            type: "pubkey";
          },
          {
            name: "treasury";
            type: "pubkey";
          },
          {
            name: "burnBps";
            type: "u16";
          },
          {
            name: "treasuryBps";
            type: "u16";
          },
          {
            name: "reviewDelay";
            type: "i64";
          },
          {
            name: "maxBank";
            type: "u64";
          },
          {
            name: "dailyCap";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "opened";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "stake";
            type: "u64";
          },
          {
            name: "fundingEnds";
            type: "i64";
          },
          {
            name: "resultEnds";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "paused";
      type: {
        kind: "struct";
        fields: [
          {
            name: "paused";
            type: "bool";
          },
        ];
      };
    },
    {
      name: "proposed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "replayHash";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "releaseAt";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "refunding";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
        ];
      };
    },
    {
      name: "reviewed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "frozen";
            type: "bool";
          },
        ];
      };
    },
    {
      name: "round";
      type: {
        kind: "struct";
        fields: [
          {
            name: "id";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "phase";
            type: "u8";
          },
          {
            name: "frozen";
            type: "bool";
          },
          {
            name: "minPlayers";
            type: "u8";
          },
          {
            name: "maxPlayers";
            type: "u8";
          },
          {
            name: "count";
            type: "u8";
          },
          {
            name: "bump";
            type: "u8";
          },
          {
            name: "vaultBump";
            type: "u8";
          },
          {
            name: "stake";
            type: "u64";
          },
          {
            name: "balance";
            type: "u64";
          },
          {
            name: "fundingEnds";
            type: "i64";
          },
          {
            name: "resultEnds";
            type: "i64";
          },
          {
            name: "releaseAt";
            type: "i64";
          },
          {
            name: "replayHash";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "players";
            type: {
              array: ["pubkey", 16];
            };
          },
          {
            name: "deposits";
            type: {
              array: ["u64", 16];
            };
          },
          {
            name: "payouts";
            type: {
              array: ["u64", 16];
            };
          },
        ];
      };
    },
    {
      name: "started";
      type: {
        kind: "struct";
        fields: [
          {
            name: "roundId";
            type: {
              array: ["u8", 32];
            };
          },
        ];
      };
    },
  ];
};
