// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
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
import { fromInt } from 'long';
import { CosmosClient } from '../indexer/api.service';
import { BlockContent } from '../indexer/types';
import {
  fetchBlocksBatches,
  filterEvents,
  filterMessageData,
  wrapEvent,
} from './cosmos';

const ENDPOINT = 'https://rpc.mainnet.archway.io';

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

jest.setTimeout(200000);
describe('CosmosUtils', () => {
  let api: CosmosClient;
  // let decodedTx: DecodedTxRaw;
  let msg: CosmosMessage;
  let block: BlockContent;

  beforeAll(async () => {
    const tendermint = await connectComet(ENDPOINT);
    const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
      ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
      ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
      ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
      ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
      ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
      ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
    ];

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(tendermint, registry);

    const [firstBlock] = await fetchBlocksBatches(api, [TEST_BLOCKNUMBER]);
    block = firstBlock.block;
    msg = block.messages[2];
  });

  afterAll(() => {
    api.disconnect();
  });

  describe('Parsing block data', () => {
    it('Correctly wraps events', () => {
      // First event of the second message
      const event = block.events[17];
      expect(event.block).toBeDefined();
      expect(event.tx).toBeDefined();
      expect(event.idx).toEqual(17);

      expect(event.msg).toBeDefined();
      expect(event.msg.msg.typeUrl).toEqual(
        '/cosmwasm.wasm.v1.MsgExecuteContract',
      );

      expect(event.msg.tx.hash).toEqual(event.tx.hash);

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
            codeId: fromInt(4),
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
            codeId: fromInt(4),
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
            codeId: fromInt(4),
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
    const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
      ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
      ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
      ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
      ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
      ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
      ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
    ];

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    api = new CosmosClient(client, registry);

    const [firstBlock] = await fetchBlocksBatches(api, [12_495_419]); // https://www.mintscan.io/neutron/block/12495419
    block = firstBlock.block;
  });

  // This test is just to ensure
  it('Is a cosmos 0.50 network', async () => {
    const status = await client.status();

    expect(status.nodeInfo.version).toMatch('0.38.');
  });

  // TODO requires these changes https://github.com/cosmos/cosmjs/compare/main...bryanchriswhite:cosmjs:main
  it('correctly has finalized block events instead of being/end block events', () => {
    // Its not yet defined if cosmjs will split finalizedBlockEvents to these to fields or define finalizedBlockEvents
    expect(block.beginBlockEvents).toBeDefined();
    expect(block.endBlockEvents).toBeDefined();
  });

  it('correctly parses events', () => {
    const event = block.events[0];
    expect(event.block).toBeDefined();
    expect(event.tx).toBeDefined();
    expect(event.idx).toEqual(0);

    expect(event.msg).toBeDefined();
    expect(event.msg.msg.typeUrl).toEqual(
      '/ibc.core.client.v1.MsgUpdateClient',
    );

    expect(event.msg.tx.hash).toEqual(event.tx.hash);

    expect(event.event).toBeDefined();
    expect(event.event.type).toEqual('message');
    expect(event.event.attributes.length).toEqual(3);

    expect(event.log.events.length).toEqual(0);
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
    const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
      ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
      ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
      ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
      ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
      ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
      ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
    ];

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
