// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { GeneratedType, Registry, DecodedTxRaw } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { connectComet, CometClient } from '@cosmjs/tendermint-rpc';
import {
  CosmosMessageFilter,
  CosmosBlock,
  CosmosTransaction,
  CosmosMessage,
  CosmosEventFilter,
} from '@subql/types-cosmos';
import {
  MsgClearAdmin,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgMigrateContract,
  MsgStoreCode,
  MsgUpdateAdmin,
} from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import long from 'long';
import { CosmosClient } from '../indexer/api.service';
import { BlockContent } from '../indexer/types';
import {
  fetchBlocksBatches,
  filterEvents,
  filterMessageData,
  wrapEvent,
} from './cosmos';

const ENDPOINT = 'https://rpc-1.archway.nodes.guru';

const TEST_BLOCKNUMBER = 4_136_542; //https://www.mintscan.io/archway/block/4136542?chainId=archway-1

const TEST_FAILTX_BLOCKNUMBER = 4136536;

const TEST_MESSAGE_FILTER_TRUE: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
  contractCall: 'swap',
  values: {
    sender: 'archway1nh8r3fka9amu4dvzf5r3lsyyx8xqm74c4vwz4s',
    contract:
      'archway1ymgz3t32j2h7j5rehwhac83tc0lkh8udc8yfh2y2hnqt9kn76xjq4zwfgw',
  },
};

const TEST_MESSAGE_FILTER_FALSE: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
  contractCall: 'increment',
  values: {
    sender: 'juno1p5afwncel44vfrvylghncu2su7we57gmf7gjcu',
    contract: 'juno1jq40jyxg57kumvaceskedcgsaje8tfagtpxsu8gnray525333yxsk8sl7f',
  },
};

const TEST_NESTED_MESSAGE_FILTER_TRUE: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
  contractCall: 'swap',
  values: {
    'msg.swap.swap_to_asset_index': 1,
  } as any, // TODO update types
};

const TEST_NESTED_MESSAGE_FILTER_FALSE: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
  contractCall: 'swap',
  values: {
    'msg.swap.input_token': 'Token2',
  },
};

const TEST_NESTED_MESSAGE_FILTER_INVALID_PATH: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
  contractCall: 'swap',
  values: {
    'msg.swap.input_token.xxx': 'Token2',
  },
};

const TEST_MESSAGE_FILTER_FALSE_2: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgStoreCode',
};

const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
  ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
  ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
  ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
  ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
  ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
  ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
];

jest.setTimeout(200000);
describe('CosmosUtils', () => {
  let api: CosmosClient;
  // let decodedTx: DecodedTxRaw;
  let msg: CosmosMessage;
  let block: BlockContent;

  beforeAll(async () => {
    const tendermint = await connectComet(ENDPOINT);
    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(tendermint, registry);

    const [firstBlock] = await fetchBlocksBatches(api, [TEST_BLOCKNUMBER]);
    block = firstBlock.block;
    msg = block.messages[2];
  });

  afterAll(() => {
    api?.disconnect();
  });

  describe('Parsing block data', () => {
    it('Correctly wraps events', () => {
      // First event of the second message
      const event = block.events[17];
      expect(event.block).toBeDefined();
      expect(event.tx).toBeDefined();
      expect(event.idx).toEqual(17);

      expect(event.msg).toBeDefined();
      expect(event.msg?.msg.typeUrl).toEqual(
        '/cosmwasm.wasm.v1.MsgExecuteContract',
      );

      expect(event.msg?.tx.hash).toEqual(event.tx.hash);

      expect(event.event).toBeDefined();
      expect(event.event.type).toEqual(
        'wasm-astrovault-cashback_minter-receive_swap_data',
      );
      expect(event.event.attributes.length).toEqual(3);

      expect(event.log.events.length).toEqual(12);
    });
  });

  describe('filtering', () => {
    it('filter message data for true', () => {
      const result = filterMessageData(msg, TEST_MESSAGE_FILTER_TRUE);
      expect(result).toEqual(true);
    });

    it('filter message data for false', () => {
      const result = filterMessageData(msg, TEST_MESSAGE_FILTER_FALSE);
      expect(result).toEqual(false);
    });

    it('filter nested message data for true', () => {
      const result = filterMessageData(msg, TEST_NESTED_MESSAGE_FILTER_TRUE);
      expect(result).toEqual(true);
    });

    it('filter nested message data for false', () => {
      const result = filterMessageData(msg, TEST_NESTED_MESSAGE_FILTER_FALSE);
      expect(result).toEqual(false);
    });

    it('filter nested message data for invalid path', () => {
      const result = filterMessageData(
        msg,
        TEST_NESTED_MESSAGE_FILTER_INVALID_PATH,
      );
      expect(result).toEqual(false);
    });

    it('does not wrap events of failed transaction', async () => {
      const blockInfo = await api.blockResults(TEST_FAILTX_BLOCKNUMBER);
      const failedTx = blockInfo.results[1];
      const tx: CosmosTransaction = {
        idx: 0,
        block: {} as CosmosBlock,
        tx: failedTx,
        hash: '',
        decodedTx: {} as DecodedTxRaw,
      };
      const events = wrapEvent({} as CosmosBlock, [tx], api.registry, 0);
      expect(events.length).toEqual(0);
    });

    // These lazy decode methods don't work as the getter is replaced with the result once called
    it.skip('does not lazy decode failed message filters', () => {
      const spy = jest.spyOn(msg.msg, 'decodedMsg', 'get');
      filterMessageData(msg, TEST_MESSAGE_FILTER_FALSE_2);
      expect(spy).not.toHaveBeenCalled();
    });

    it.skip('lazy decode passed message filters', () => {
      const spy = jest.spyOn(msg.msg, 'decodedMsg', 'get');
      filterMessageData(msg, TEST_MESSAGE_FILTER_TRUE);
      expect(spy).toHaveBeenCalled();
    });

    it('can filter long type decoded msg for true', () => {
      const msg: CosmosMessage = {
        tx: null,
        msg: {
          typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
          decodedMsg: {
            codeId: long.fromInt(4),
          },
        },
      } as unknown as CosmosMessage;

      const filter: CosmosMessageFilter = {
        type: '/cosmwasm.wasm.v1.MsgInstantiateContract',
        values: {
          codeId: '4',
        },
        includeFailedTx: true,
      };

      const result = filterMessageData(msg, filter);
      expect(result).toEqual(true);
    });

    it('can filter long type decoded msg for number filter', () => {
      const msg: CosmosMessage = {
        tx: null,
        msg: {
          typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
          decodedMsg: {
            codeId: long.fromInt(4),
          },
        },
      } as unknown as CosmosMessage;

      const filter: CosmosMessageFilter = {
        type: '/cosmwasm.wasm.v1.MsgInstantiateContract',
        values: {
          codeId: 4 as unknown as string,
        },
        includeFailedTx: true,
      };

      const result = filterMessageData(msg, filter);
      expect(result).toEqual(true);
    });

    it('can filter long type decoded msg for false', () => {
      const msg: CosmosMessage = {
        tx: null,
        msg: {
          typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
          decodedMsg: {
            codeId: long.fromInt(4),
          },
        },
      } as unknown as CosmosMessage;

      const filter: CosmosMessageFilter = {
        type: '/cosmwasm.wasm.v1.MsgInstantiateContract',
        values: {
          codeId: '5',
        },
        includeFailedTx: true,
      };

      const result = filterMessageData(msg, filter);
      expect(result).toEqual(false);
    });
  });

  describe('filterMessageData function', () => {
    const baseData = {
      tx: {
        tx: {
          code: 0,
        },
      },
      msg: {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        decodedMsg: {
          msg: {},
        },
      },
    } as unknown as CosmosMessage;

    describe('contractCall filtering', () => {
      it('should return true for non-object contractCall in msg', () => {
        const data = {
          ...baseData,
          msg: {
            ...baseData.msg,
            decodedMsg: {
              msg: 'nonObjectContractCall',
            },
          },
        };
        const filter = {
          type: '/cosmwasm.wasm.v1.MsgExecuteContract',
          contractCall: 'nonObjectContractCall',
        };

        const result = filterMessageData(data, filter);
        expect(result).toBe(true);
      });

      it('should return false for non-object contractCall not in msg', () => {
        const data = {
          ...baseData,
          msg: {
            ...baseData.msg,
            decodedMsg: {
              msg: 'nonObjectContractCall2',
            },
          },
        };
        const filter = {
          type: '/cosmwasm.wasm.v1.MsgExecuteContract',
          contractCall: 'nonObjectContractCall',
        };

        const result = filterMessageData(data, filter);
        expect(result).toBe(false);
      });

      it('should return false for object contractCall not in msg', () => {
        const filter = {
          type: '/cosmwasm.wasm.v1.MsgExecuteContract',
          contractCall: 'notInMsg',
        };

        const result = filterMessageData(baseData, filter);
        expect(result).toBe(false);
      });

      it('should return true for object contractCall in msg', () => {
        const contractCall = { inMsg: 'inMsg' };
        const data = {
          ...baseData,
          msg: {
            ...baseData.msg,
            decodedMsg: {
              msg: contractCall,
            },
          },
        };
        const filter = {
          type: '/cosmwasm.wasm.v1.MsgExecuteContract',
          contractCall: 'inMsg',
        };

        const result = filterMessageData(data, filter);
        expect(result).toBe(true);
      });
    });
  });
});

describe('Cosmos 0.50 support', () => {
  let api: CosmosClient;
  let client: CometClient;
  let block: BlockContent;

  beforeAll(async () => {
    client = await connectComet('https://rpc.neutron.quokkastake.io');

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(client, registry);

    const [firstBlock] = await fetchBlocksBatches(api, [19_091_812]); // https://www.mintscan.io/neutron/block/12495419
    block = firstBlock.block;
  });

  // This test is just to ensure
  it('Is a cosmos 0.50 network', async () => {
    const status = await client.status();

    expect(status.nodeInfo.version).toMatch('0.38.');
  });

  it('correctly has finalized block events instead of being/end block events', () => {
    expect(block.beginBlockEvents?.length).toEqual(0);
    expect(block.endBlockEvents?.length).toEqual(0);
    expect(block.finalizeBlockEvents?.length).toBeGreaterThan(0);
  });

  it('correctly parses events', () => {
    // Failed tx event
    const event = block.events[0];
    expect(event.block).toBeDefined();
    expect(event.tx).toBeDefined();
    expect(event.idx).toEqual(16);

    // Failed tx
    const event2 = block.events[27];
    expect(event2.block).toBeDefined();
    expect(event2.tx).toBeDefined();
    expect(event2.idx).toEqual(43);

    expect(event2.msg).toBeDefined();
    expect(event2.msg?.msg.typeUrl).toEqual(
      '/ibc.core.client.v1.MsgUpdateClient',
    );

    expect(event2.msg?.tx.hash).toEqual(event2.tx.hash);

    expect(event2.event).toBeDefined();
    expect(event2.event.type).toEqual('message');
    expect(event2.event.attributes.length).toEqual(3);

    expect(event2.log.events.length).toEqual(0);
  });

  it('Correctly wraps events not associated to a message', async () => {
    const [{ block }] = await fetchBlocksBatches(api, [19_091_812]);

    expect(block.events.length).toBe(287);

    expect(block.transactions[0].tx.events.length).toBe(21);

    const txEvents = block.events.filter(
      (evt) =>
        evt.tx.hash ===
        '5F5DC2EECF1D8EDDE07BC0AD4F91A48BEB35E2A0D813BD2D21EA90B85F0BAB95',
    );
    expect(txEvents.length).toBe(21);
    const nonMessageTxs = txEvents.filter((evt) => evt.msg === undefined);
    expect(nonMessageTxs.length).toBe(16);
  });

  it('Can stringify a block', () => {
    expect(() => JSON.stringify(block.block)).not.toThrow();
  });

  // block.tx when block.block.tx cannot be decoded
  // {
  //    code: 2,
  //    codespace: 'sdk',
  //    log: 'tx parse error',
  //    data: undefined,
  //    events: [],
  //    gasWanted: 0n,
  //    gasUsed: 0n
  //  }

  it('doesnt throw when a block contains ExtendedCommitInfo in the transactions', async () => {
    const [firstBlock] = await fetchBlocksBatches(api, [13_379_322]); // https://www.mintscan.io/neutron/block/13379322
    const block = firstBlock.block;

    expect(block.messages.length).toEqual(4);
  });
});

describe('Cosmos bigint support', () => {
  const TEST_BIGINT_BLOCKNUMBER = 17838575;
  const TEST_BIGINT_SUCC: CosmosEventFilter = {
    type: 'transfer',
    messageFilter: {
      type: '/ibc.applications.transfer.v1.MsgTransfer',
      values: {
        timeoutTimestamp: '1723738770000000000',
      },
    },
  };

  const TEST_BIGINT_FAIL: CosmosEventFilter = {
    type: 'transfer',
    messageFilter: {
      type: '/ibc.applications.transfer.v1.MsgTransfer',
      values: {
        timeoutTimestamp: '2723738770000000000',
      },
    },
  };
  let api: CosmosClient;
  let client: CometClient;
  let block: BlockContent;

  beforeAll(async () => {
    // chainId: fetchhub-4
    // endpoint: https://rpc-fetchhub.fetch.ai
    client = await connectComet('https://rpc-fetchhub.fetch.ai');

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(client, registry);

    const [firstBlock] = await fetchBlocksBatches(api, [
      TEST_BIGINT_BLOCKNUMBER,
    ]);
    block = firstBlock.block;
  });

  it('bigint field check', () => {
    const succEvents = filterEvents(block.events, TEST_BIGINT_SUCC);
    const failEvents = filterEvents(block.events, TEST_BIGINT_FAIL);

    expect(succEvents.length).toEqual(1);
    expect(failEvents.length).toEqual(0);
  });
});

describe('Failed transaction events', () => {
  let api: CosmosClient;
  let client: CometClient;
  let block: BlockContent;

  beforeAll(async () => {
    // chainId: fetchhub-4
    // endpoint: https://rpc-fetchhub.fetch.ai
    client = await connectComet(
      'https://shannon-testnet-grove-rpc.beta.poktroll.com',
    );

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(client, registry);

    const [firstBlock] = await fetchBlocksBatches(api, [348]);
    block = firstBlock.block;
  });

  it('The block includes events from failed transactions', () => {
    const failedTx =
      '07DFC25C9387BEA3928A2F2DF465E2EC93246456498366FCADB953B6A706B96B';

    const tx = block.transactions.find((tx) => tx.hash === failedTx);
    expect(tx).toBeDefined();

    const evts = block.events.filter((evt) => evt.tx.hash === failedTx);
    expect(evts.length).toBeGreaterThan(0);
    expect(evts.length).toEqual(tx!.tx.events.length);
  });
});

describe('Celestia support', () => {
  let api: CosmosClient;

  beforeAll(async () => {
    const tendermint = await connectComet(
      'https://celestia-rpc.publicnode.com:443',
    );
    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(tendermint, registry);
  });

  it('can decode a transaction', async () => {
    const height = await api.getHeight();

    // Go back 100 blocks to ensure the node has the block, we just want a recent block because of pruning
    const blockHeight = height - 100;

    const [block] = await fetchBlocksBatches(api, [blockHeight]);

    // TODO blocks might not have transactions
    expect(block.block.transactions.length).toBeGreaterThan(0);

    const tx = block.block.transactions[0];

    // This is a getter function so wrap it in a function to try and catch the error
    expect(() => tx.decodedTx).not.toThrow();

    expect(tx.hash).toBeDefined();
  });
});
