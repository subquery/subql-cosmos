// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {
  GeneratedType,
  Registry,
  decodeTxRaw,
  DecodedTxRaw,
} from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import {
  CosmosMessageFilter,
  CosmosBlock,
  CosmosTransaction,
  CosmosMessage,
} from '@subql/types-cosmos';
import {
  MsgClearAdmin,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgMigrateContract,
  MsgStoreCode,
  MsgUpdateAdmin,
} from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { isLong, fromInt } from 'long';
import { CosmosClient } from '../indexer/api.service';
import { HttpClient } from '../indexer/rpc-clients';
import { decodeMsg, filterMessageData, wrapEvent } from './cosmos';

const ENDPOINT = 'https://rpc-archive.junonetwork.io/';

const TEST_BLOCKNUMBER = 4136538;

const TEST_FAILTX_BLOCKNUMBER = 4136536;

const TEST_MESSAGE_FILTER_TRUE: CosmosMessageFilter = {
  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
  contractCall: 'swap',
  values: {
    sender: 'juno1p5afwncel44vfrvylghncu2su7we57gmf7gjcu',
    contract: 'juno1e8n6ch7msks487ecznyeagmzd5ml2pq9tgedqt2u63vra0q0r9mqrjy6ys',
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
    'msg.swap.input_token': 'Token1',
  },
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
  let decodedTx: DecodedTxRaw;
  let msg: CosmosMessage;

  beforeAll(async () => {
    const client = new HttpClient(ENDPOINT);
    const tendermint = await Tendermint37Client.create(client);
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
    const block = await api.getBlock(TEST_BLOCKNUMBER);
    const tx = block.txs[1];
    decodedTx = decodeTxRaw(tx);
    msg = {
      idx: 0,
      block: {} as CosmosBlock,
      tx: {
        tx: {
          code: 0,
        },
      } as CosmosTransaction,
      msg: {
        typeUrl: decodedTx.body.messages[0].typeUrl,
        get decodedMsg() {
          return decodeMsg<any>(decodedTx.body.messages[0], registry);
        },
      },
    };
  });

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

  it('does not lazy decode failed message filters', () => {
    const spy = jest.spyOn(msg.msg, 'decodedMsg', 'get');
    const result = filterMessageData(msg, TEST_MESSAGE_FILTER_FALSE_2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('lazy decode passed message filters', () => {
    const spy = jest.spyOn(msg.msg, 'decodedMsg', 'get');
    const result = filterMessageData(msg, TEST_MESSAGE_FILTER_TRUE);
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

  afterEach(() => {
    api.disconnect();
  });
});
