// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {
  CosmosCustomDatasource,
  CosmosDatasource,
  CosmosDatasourceKind,
  CosmosHandlerKind,
} from '@subql/types-cosmos';
import { cloneDeep, omit } from 'lodash';
import { BlockchainService } from './blockchain.service';
import { SubqueryProject } from './configure/SubqueryProject';

describe('Creating dynamic ds', () => {
  let blockchainService: BlockchainService;
  let project: SubqueryProject;

  const getTemplate = (
    name: string,
  ): CosmosDatasource | CosmosCustomDatasource => {
    return cloneDeep(
      omit(project.templates.find((t) => t.name === name)!, 'name'),
    )! as any;
  };

  beforeEach(() => {
    project = {
      id: '',
      root: '',
      dataSources: [],
      templates: [
        {
          name: 'cosmos',
          kind: CosmosDatasourceKind.Runtime,
          mapping: {
            file: '',
            handlers: [
              {
                handler: 'handleEvent',
                kind: CosmosHandlerKind.Event,
                filter: {
                  type: 'execute',
                  messageFilter: {
                    type: '/cosmwasm.wasm.v1.MsgExecuteContract',
                  },
                },
              },
              {
                handler: 'handleMessage',
                kind: CosmosHandlerKind.Message,
                filter: {
                  type: '/cosmwasm.wasm.v1.MsgExecuteContract',
                },
              },
            ],
          },
        },
        {
          name: 'cosmos2',
          kind: CosmosDatasourceKind.Runtime,
          mapping: {
            file: '',
            handlers: [
              {
                handler: 'handleEvent',
                kind: CosmosHandlerKind.Event,
                filter: {
                  type: 'execute',
                },
              },
            ],
          },
        },
      ],
    } as unknown as SubqueryProject;
    blockchainService = new BlockchainService(null as any);
  });

  // Cant test this because createDynamicDatasource calls process.exit on error
  it('Should validate the arguments', async () => {
    await expect(
      blockchainService.updateDynamicDs(
        {
          startBlock: 100,
          args: [] as any,
          templateName: 'cosmos',
        },
        getTemplate('cosmos'),
      ),
    ).rejects.toThrow();

    await expect(
      blockchainService.updateDynamicDs(
        {
          templateName: 'cosmos',
          startBlock: 100,
          args: {
            notValues: {},
            attributes: [],
          },
        },
        getTemplate('cosmos'),
      ),
    ).rejects.toThrow();
  });

  it('Should be able to set an address for a cosmwasm contract', async () => {
    const ds = getTemplate('cosmos');
    await blockchainService.updateDynamicDs(
      {
        templateName: 'cosmos',
        startBlock: 100,
        args: {
          values: { contract: 'cosmos1' },
          attributes: { _contract_address: 'cosmos_wasm' },
        },
      },
      ds,
    );

    expect(ds).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      // startBlock: 100,
      mapping: {
        file: '',
        handlers: [
          {
            handler: 'handleEvent',
            kind: CosmosHandlerKind.Event,
            filter: {
              type: 'execute',
              messageFilter: {
                type: '/cosmwasm.wasm.v1.MsgExecuteContract',
                values: {
                  contract: 'cosmos1',
                },
              },
              attributes: {
                _contract_address: 'cosmos_wasm',
              },
            },
          },
          {
            handler: 'handleMessage',
            kind: CosmosHandlerKind.Message,
            filter: {
              type: '/cosmwasm.wasm.v1.MsgExecuteContract',
              values: {
                contract: 'cosmos1',
              },
            },
          },
        ],
      },
    });

    // Check that the project templates don't get mutated
    expect(project.templates[0].mapping.handlers[0].filter).toEqual({
      type: 'execute',
      messageFilter: {
        type: '/cosmwasm.wasm.v1.MsgExecuteContract',
      },
    });

    expect(project.templates[0].mapping.handlers[1].filter).toEqual({
      type: '/cosmwasm.wasm.v1.MsgExecuteContract',
    });
  });

  it('should not add empty properties to dynamic ds', async () => {
    const ds = getTemplate('cosmos');
    await blockchainService.updateDynamicDs(
      {
        templateName: 'cosmos',
        startBlock: 100,
        args: {
          attributes: { _contract_address: 'cosmos_wasm' },
        },
      },
      ds,
    );

    expect(ds).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      // startBlock: 100,
      mapping: {
        file: '',
        handlers: [
          {
            handler: 'handleEvent',
            kind: CosmosHandlerKind.Event,
            filter: {
              type: 'execute',
              messageFilter: {
                type: '/cosmwasm.wasm.v1.MsgExecuteContract',
              },
              attributes: {
                _contract_address: 'cosmos_wasm',
              },
            },
          },
          {
            handler: 'handleMessage',
            kind: CosmosHandlerKind.Message,
            filter: {
              type: '/cosmwasm.wasm.v1.MsgExecuteContract',
            },
          },
        ],
      },
    });

    const ds2 = getTemplate('cosmos');
    await blockchainService.updateDynamicDs(
      {
        templateName: 'cosmos',
        startBlock: 100,
        args: {
          values: { contract: 'cosmos1' },
        },
      },
      ds2,
    );

    expect(ds2).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      // startBlock: 100,
      mapping: {
        file: '',
        handlers: [
          {
            handler: 'handleEvent',
            kind: CosmosHandlerKind.Event,
            filter: {
              type: 'execute',
              messageFilter: {
                type: '/cosmwasm.wasm.v1.MsgExecuteContract',
                values: {
                  contract: 'cosmos1',
                },
              },
            },
          },
          {
            handler: 'handleMessage',
            kind: CosmosHandlerKind.Message,
            filter: {
              type: '/cosmwasm.wasm.v1.MsgExecuteContract',
              values: {
                contract: 'cosmos1',
              },
            },
          },
        ],
      },
    });

    const ds3 = getTemplate('cosmos2');
    await blockchainService.updateDynamicDs(
      {
        templateName: 'cosmos2',
        startBlock: 100,
        args: {
          attributes: { _contract_address: 'cosmos_wasm' },
        },
      },
      ds3,
    );

    expect(ds3).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      // startBlock: 100,
      mapping: {
        file: '',
        handlers: [
          {
            handler: 'handleEvent',
            kind: CosmosHandlerKind.Event,
            filter: {
              type: 'execute',
              attributes: {
                _contract_address: 'cosmos_wasm',
              },
            },
          },
        ],
      },
    });
  });
});
