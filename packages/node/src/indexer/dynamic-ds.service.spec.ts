// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { CacheMetadataModel } from '@subql/node-core';
import { CosmosDatasourceKind, CosmosHandlerKind } from '@subql/types-cosmos';
import { SubqueryProject } from '../configure/SubqueryProject';
import { DynamicDsService } from './dynamic-ds.service';

function getMetadata(): CacheMetadataModel {
  let dynamicDs: any[] = [];

  const metadata = {
    set: (key: string, data: any[]) => {
      dynamicDs = data;
    },
    setNewDynamicDatasource: (newDs: any) => {
      dynamicDs.push(newDs);
    },
    find: (key: string) => Promise.resolve(dynamicDs),
  };

  return metadata as CacheMetadataModel;
}

describe('Creating dynamic ds', () => {
  let dynamiDsService: DynamicDsService;
  let project: SubqueryProject;

  beforeEach(async () => {
    project = new SubqueryProject(
      '',
      '',
      null,
      [],
      null,
      [
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
      null,
      null,
      null,
    );
    dynamiDsService = new DynamicDsService(null, project);

    await dynamiDsService.init(getMetadata());
  });

  // Cant test this because createDynamicDatasource calls process.exit on error
  it.skip('Should validate the arguments', async () => {
    await expect(
      dynamiDsService.createDynamicDatasource({
        templateName: 'cosmos',
        startBlock: 100,
        args: [] as any,
      }),
    ).rejects.toThrow();

    await expect(
      dynamiDsService.createDynamicDatasource({
        templateName: 'cosmos',
        startBlock: 100,
        args: {
          notValues: {},
          attributes: [],
        },
      }),
    ).rejects.toThrow();
  });

  it('Should be able to set an address for a cosmwasm contract', async () => {
    const ds = await dynamiDsService.createDynamicDatasource({
      templateName: 'cosmos',
      startBlock: 100,
      args: {
        values: { contract: 'cosmos1' },
        attributes: { _contract_address: 'cosmos_wasm' },
      },
    });

    expect(ds).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      startBlock: 100,
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
    const ds = await dynamiDsService.createDynamicDatasource({
      templateName: 'cosmos',
      startBlock: 100,
      args: {
        attributes: { _contract_address: 'cosmos_wasm' },
      },
    });

    expect(ds).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      startBlock: 100,
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

    const ds2 = await dynamiDsService.createDynamicDatasource({
      templateName: 'cosmos',
      startBlock: 100,
      args: {
        values: { contract: 'cosmos1' },
      },
    });

    expect(ds2).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      startBlock: 100,
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

    const ds3 = await dynamiDsService.createDynamicDatasource({
      templateName: 'cosmos2',
      startBlock: 100,
      args: {
        attributes: { _contract_address: 'cosmos_wasm' },
      },
    });

    expect(ds3).toEqual({
      kind: CosmosDatasourceKind.Runtime,
      startBlock: 100,
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
