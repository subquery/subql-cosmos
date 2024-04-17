// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import fs from 'fs';
import path from 'path';
import { toHex } from '@cosmjs/encoding';
import { Uint53 } from '@cosmjs/math';
import { toRfc3339WithNanoseconds } from '@cosmjs/tendermint-rpc';
import { INestApplication } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { loadFromJsonOrYaml, makeTempDir } from '@subql/common';
import {
  ConnectionPoolService,
  ConnectionPoolStateManager,
  delay,
  NodeConfig,
} from '@subql/node-core';
import { GraphQLSchema } from 'graphql';
import Pino from 'pino';
import { SubqueryProject } from '../configure/SubqueryProject';
import { LazyBlockContent } from '../utils/cosmos';
import { ApiService } from './api.service';

const TEST_BLOCKNUMBER = 3266772;

const projectsDir = path.join(__dirname, '../../test');

function testCosmosProject(
  endpoint: string,
  chainId: string,
  fileCacheDir?: string,
): SubqueryProject {
  return {
    network: {
      endpoint: [endpoint],
      chainId: chainId,
    },
    dataSources: [],
    id: 'test',
    root: './',
    schema: new GraphQLSchema({}),
    templates: [],
    fileCacheDir,
  } as SubqueryProject;
}

jest.setTimeout(200000);

describe('ApiService', () => {
  let app: INestApplication;
  let apiService: ApiService;

  let tmpPath: string;

  const prepareApiService = async (
    endpoint: string,
    chainId: string,
    fileCacheDir?: string,
  ) => {
    const module = await Test.createTestingModule({
      providers: [
        ConnectionPoolStateManager,
        ConnectionPoolService,
        {
          provide: 'ISubqueryProject',
          useFactory: () => testCosmosProject(endpoint, chainId, fileCacheDir),
        },
        {
          provide: NodeConfig,
          useFactory: () => ({}),
        },
        EventEmitter2,
        ApiService,
        NodeConfig,
      ],
      imports: [EventEmitterModule.forRoot()],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    apiService = app.get(ApiService);
    (apiService as any).nodeConfig._config.kyveEndpoint =
      'https://api-us-1.kyve.network';
    (apiService as any).nodeConfig._config.kyveStorageUrl =
      'https://arweave.net';
    await apiService.init();
  };

  const ENDPOINT = 'https://rpc-juno.itastakers.com/';
  const CHAINID = 'juno-1';

  describe('RPC api service', () => {
    beforeAll(async () => {
      tmpPath = await makeTempDir();
    });
    it('Falls back on rpc if kyve fails', async () => {
      const endpoint = 'https://rpc.mainnet.archway.io:443';
      const chainId = 'archway-1';

      await prepareApiService(endpoint, chainId, tmpPath);

      jest
        .spyOn((apiService as any).kyveApi, 'retrieveBundleData')
        .mockRejectedValueOnce(
          'Error: Client network socket disconnected before secure TLS connection was established',
        );

      const rpcFetchSpy = jest.spyOn(apiService as any, 'retryFetch');

      await apiService.fetchBlocks([1]);

      expect(rpcFetchSpy).toHaveBeenCalledTimes(1);
    });
    it.skip('query block info', async () => {
      await prepareApiService(ENDPOINT, CHAINID, tmpPath);

      const api = apiService.api;
      const blockInfo = await api.blockInfo(TEST_BLOCKNUMBER);
      const doc: any = loadFromJsonOrYaml(
        path.join(projectsDir, 'block_3266772.json'),
      );
      const realBlockInfo = {
        id: toHex(doc.block_id.hash).toUpperCase(),
        header: {
          version: {
            block: new Uint53(+doc.block.header.version.block).toString(),
            app: blockInfo.block.header.version.app,
          },
          height: doc.block.header.height,
          chainId: doc.block.header.chainId,
          time: toRfc3339WithNanoseconds(doc.block.header.time),
        },
        txs: doc.block.txs,
      };
      expect(blockInfo).toMatchObject(realBlockInfo);
    });

    it.skip('query tx info by height', async () => {
      await prepareApiService(ENDPOINT, CHAINID, tmpPath);

      const api = apiService.api;
      const txInfos = await api.txInfoByHeight(TEST_BLOCKNUMBER);
      expect(txInfos.length).toEqual(4);
    });
  });
});
