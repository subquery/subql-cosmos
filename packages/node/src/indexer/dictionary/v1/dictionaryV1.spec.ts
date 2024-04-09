// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { CosmosMessageFilter } from '@subql/common-cosmos';
import { NodeConfig } from '@subql/node-core';
import { DictionaryV1, messageFilterToQueryEntry } from './dictionaryV1';

// describe('dictionary service', () => {
//   let dictionaryService: DictionaryV1;

//   beforeEach(async () => {
//     dictionaryService = await DictionaryV1.create(
//       {
//         network: {
//           chainId: 'juno-1',
//           dictionary:
//             'https://api.subquery.network/sq/subquery/cosmos-juno-dictionary',
//         },
//       } as any,
//       { dictionaryTimeout: 10000 } as NodeConfig,
//       new EventEmitter2(),
//     );
//   });

//   it('successfully validates metatada', async () => {
//     /* Genesis hash is unused with cosmos, chainId is used from project instead */
//     await expect(
//       dictionaryService.initValidation('juno-1'),
//     ).resolves.toBeTruthy();
//   });
// });

type DictionaryQuery = DictionaryV1['dictionaryQuery'];
type DictionaryServicePrivate = DictionaryV1 & {
  dictionaryQuery: DictionaryQuery;
};

const nodeConfig = new NodeConfig({
  subquery: 'asdf',
  subqueryName: 'asdf',
  networkEndpoint: ['https://rpc-juno.itastakers.com/'],
  dictionaryTimeout: 10,
});

// eslint-disable-next-line @typescript-eslint/require-await
async function mockDictionaryService(
  url: string,
): Promise<DictionaryServicePrivate> {
  return DictionaryV1.create(
    {
      network: {
        dictionary: url,
        chianId: 'juno-1',
      },
    } as any,
    nodeConfig,
    () => {
      throw new Error(`Shouldn't be called`);
    },
    url,
  ) as DictionaryServicePrivate;
}

describe('Dictionary Queries', () => {
  let dictionary: DictionaryServicePrivate;

  beforeAll(async () => {
    dictionary = await mockDictionaryService(
      'https://gateway.subquery.network/query/QmPjq55mgUt9S8S491Q3wEbb87fXyEkdxymT6Gwe2xe1Z1',
    );
  });

  describe('Message Filter Queries', () => {
    it('Basic wasm filter works', () => {
      const filter: CosmosMessageFilter = {
        type: '/cosmwasm.wasm.v1.MsgExecuteContract',
      };

      const condition = messageFilterToQueryEntry(filter);

      const query = (dictionary as any).dictionaryQuery(
        3_093_822,
        4_000_000,
        5,
        [condition],
      );

      expect(query).toEqual({
        query: `query($messages_0_0:String!){_metadata {lastProcessedHeight chain }  messages (filter:{or:[{type:{equalTo:$messages_0_0}}],blockHeight:{greaterThanOrEqualTo:"3093822",lessThan:"4000000"}},orderBy:BLOCK_HEIGHT_ASC,first:5,distinct:[BLOCK_HEIGHT]){nodes {blockHeight }  } }`,
        variables: { messages_0_0: '/cosmwasm.wasm.v1.MsgExecuteContract' },
      });
    });

    it('Wasm with contract filter builds a valid query', () => {
      const filter: CosmosMessageFilter = {
        type: '/cosmwasm.wasm.v1.MsgExecuteContract',
        contractCall: 'vote',
        values: {
          contract:
            'juno1lgnstas4ruflg0eta394y8epq67s4rzhg5anssz3rc5zwvjmmvcql6qps2',
        },
      };

      const condition = messageFilterToQueryEntry(filter);

      const query = (dictionary as any).dictionaryQuery(
        3_093_822,
        4_000_000,
        5,
        [condition],
      );

      expect(query).toEqual({
        query: `query($messages_0_0:String!,$messages_0_1:JSON){_metadata {lastProcessedHeight chain }  messages (filter:{or:[{and:[{type:{equalTo:$messages_0_0}},{data:{contains:$messages_0_1}}]}],blockHeight:{greaterThanOrEqualTo:"3093822",lessThan:"4000000"}},orderBy:BLOCK_HEIGHT_ASC,first:5,distinct:[BLOCK_HEIGHT]){nodes {blockHeight }  } }`,
        variables: {
          messages_0_0: '/cosmwasm.wasm.v1.MsgExecuteContract',
          messages_0_1: {
            contract:
              'juno1lgnstas4ruflg0eta394y8epq67s4rzhg5anssz3rc5zwvjmmvcql6qps2',
          },
        },
      });
    });

    it('Wasm with nested filter works', () => {
      const filter: CosmosMessageFilter = {
        type: '/cosmwasm.wasm.v1.MsgExecuteContract',
        contractCall: 'swap',
        values: {
          'msg.swap.input_token': 'Token2',
        },
      };

      const condition = messageFilterToQueryEntry(filter);

      expect(condition.conditions[1].value).toEqual({
        msg: { swap: { input_token: 'Token2' } },
      });
    });

    // it('Wasm with enum filter works', () => {
    //   const filter: CosmosMessageFilter = {
    //     type: '/cosmwasm.wasm.v1.MsgExecuteContract',
    //     contractCall: 'swap',
    //     values: {
    //       'msg.swap.input_token': 'Token2',
    //     },
    //   };

    //   const condition = messageFilterToQueryEntry(filter);

    //   console.log('CONDITION', condition, condition.conditions[1].value);

    //   const query = (dictionary as any).dictionaryQuery(
    //     3_093_822, 4_000_000, 5, [condition]
    //   );

    //   console.log('QUERY', query.query, query.variables);

    // });
  });

  // describe('Event Filter Queries', () => {

  // });
});
