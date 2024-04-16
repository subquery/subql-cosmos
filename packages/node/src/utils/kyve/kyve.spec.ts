// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { promisify } from 'util';
import { gzipSync } from 'zlib';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
import KyveSDK from '@kyvejs/sdk';
import { makeTempDir } from '@subql/common';
import axios from 'axios';
import {
  MsgClearAdmin,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgMigrateContract,
  MsgStoreCode,
  MsgUpdateAdmin,
} from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { isEqual } from 'lodash';
import rimraf from 'rimraf';
import { HttpClient } from '../../indexer/rpc-clients';
import { LazyBlockContent } from '../cosmos';
import { KyveApi } from './kyve';
import { BundleDetails } from './kyveTypes';

const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
  ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
  ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
  ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
  ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
  ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
  ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
];

const kyveBundlePath = path.join(
  __dirname,
  '../../../test/kyve_block/block_3856726.json',
);
const block_3856726 = require(kyveBundlePath);

const KYVE_ENDPOINT = 'https://rpc-eu-1.kyve.network';
const KYVE_STORAGE_URL = 'https://arweave.net';
const KYVE_CHAINID = 'kyve-1';

jest.setTimeout(100000);
describe('KyveApi', () => {
  let kyveApi: KyveApi;
  let tendermint: Tendermint37Client;
  let registry: Registry;

  let tmpPath: string;
  let retrieveBundleDataSpy: jest.SpyInstance;
  let decoderBlockResultsSpy: jest.SpyInstance;
  let decoderBlockSpy: jest.SpyInstance;
  let injectLogSpy: jest.SpyInstance;
  let readerSpy: jest.SpyInstance;

  let zippedMockResp: Buffer;
  let mockStream: Readable;

  beforeAll(async () => {
    tmpPath = await makeTempDir();

    registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    kyveApi = await KyveApi.create(
      'archway-1',
      KYVE_ENDPOINT,
      KYVE_STORAGE_URL,
      KYVE_CHAINID,
      tmpPath,
    );
    const client = new HttpClient('https://rpc.mainnet.archway.io:443');
    tendermint = await Tendermint37Client.create(client);
  });
  beforeEach(async () => {
    retrieveBundleDataSpy = jest.spyOn(kyveApi as any, 'retrieveBundleData');
    decoderBlockSpy = jest.spyOn(kyveApi as any, 'decodeBlock');
    decoderBlockResultsSpy = jest.spyOn(kyveApi as any, 'decodeBlockResult');
    injectLogSpy = jest.spyOn(kyveApi as any, 'injectLogs');
    readerSpy = jest.spyOn(kyveApi as any, 'readFromFile');

    zippedMockResp = gzipSync(Buffer.from(JSON.stringify(block_3856726)));
    mockStream = new Readable({
      read() {
        this.push(zippedMockResp);
        this.push(null);
      },
    });

    const files = await fs.promises.readdir(tmpPath);
    for (const file of files) {
      await fs.promises.unlink(path.join(tmpPath, file));
    }
  });

  afterEach(() => {
    retrieveBundleDataSpy.mockRestore();
    decoderBlockSpy.mockRestore();
    decoderBlockResultsSpy.mockRestore();
    injectLogSpy.mockRestore();
    readerSpy.mockRestore();

    // reset cache
    (kyveApi as any).cachedBundleDetails = [];
  });
  afterAll(async () => {
    await promisify(rimraf)(tmpPath);
  });

  it('ensure bundleDetails', async () => {
    const bundleDetails = await (kyveApi as any).getBundleById(0);
    expect(bundleDetails).toEqual({
      pool_id: '2',
      id: '0',
      storage_id: 'YLpTxtj_0ICoWq9HUEOx6VcIzKk8Qui1rnkhH4acbTU',
      uploader: 'kyve1z6wduz3psfuhp87r4enfnaelhcf94uksgjs0qj',
      from_index: '0',
      to_index: '150',
      from_key: '1',
      to_key: '150',
      bundle_summary: '150',
      data_hash:
        'a5915a350030e60224909c82c0c7058f7096d401202fb8a05724e059d89ff7a5',
      finalized_at: { height: '2589775', timestamp: '2023-09-06T12:20:22Z' },
      storage_provider_id: '2',
      compression_id: '1',
      stake_security: {
        valid_vote_power: '954119472714',
        total_vote_power: '1185083547399',
      },
    });
  });

  it('ensure correct bundle ID on binary search', async () => {
    (kyveApi as any).currentBundleId = -1; // reset cached bundle Id
    const a = Date.now();
    const firstBundle = await (kyveApi as any).getBundleId(120); // https://app.kyve.network/#/pools/2/bundles/0
    const b = Date.now();
    console.log(`${b - a}ms`);

    const laterBundle = await (kyveApi as any).getBundleId(3489747); // https://app.kyve.network/#/pools/2/bundles/5149474
    expect(firstBundle).toBe(0);
    expect(laterBundle).toBe(113773);
  });
  it('Able to write and read with parallel calls', async () => {
    const bundle_0Data = [
      {
        key: '1',
        value: {
          block: {},
          block_results: {},
        },
      },
      {
        key: '150',
        value: {
          block: {},
          block_results: {},
        },
      },
    ];

    const bundle_1Data = [
      {
        key: '151',
        value: {
          block: {},
          block_results: {},
        },
      },
      {
        key: '300',
        value: {
          block: {},
          block_results: {},
        },
      },
    ];
    const bundle_2Data = [
      {
        key: '301',
        value: {
          block: {},
          block_results: {},
        },
      },
    ];

    const steam0 = new Readable({
      read() {
        this.push(gzipSync(Buffer.from(JSON.stringify(bundle_0Data))));
        this.push(null);
      },
    });
    const steam1 = new Readable({
      read() {
        this.push(gzipSync(Buffer.from(JSON.stringify(bundle_1Data))));
        this.push(null);
      },
    });
    const steam2 = new Readable({
      read() {
        this.push(gzipSync(Buffer.from(JSON.stringify(bundle_2Data))));
        this.push(null);
      },
    });

    retrieveBundleDataSpy.mockImplementation((storageId: string) => {
      switch (storageId) {
        case 'YLpTxtj_0ICoWq9HUEOx6VcIzKk8Qui1rnkhH4acbTU':
          return { data: steam0 };
        case 'nLFqaswVsuwZb1QoEXdLTOiB8o69AyxEGHzmxT1TNsw':
          return { data: steam1 };
        case 'PnvgDqr8xq6xr9ZIwXZAo96uMb2Zil3muoVOl6eUpD8':
          return { data: steam2 };
        default:
          break;
      }
    });

    decoderBlockSpy.mockImplementation(
      (block: JsonRpcSuccessResponse) => block,
    );
    decoderBlockResultsSpy.mockImplementation(
      (blockResult: JsonRpcSuccessResponse) => blockResult,
    );
    injectLogSpy.mockImplementation(
      (kyveBlockResult: BlockResultsResponse) => kyveBlockResult,
    );

    // TODO, should this be called with promise.all or for loop ?
    // for (const height of [1, 151, 151, 300, 301]) {
    //   await kyveApi.getBlockByHeight(height)
    // }
    // expect download to be called multiple times

    const blocks = await Promise.all([
      kyveApi.getBlockByHeight(1),
      kyveApi.getBlockByHeight(151),
      kyveApi.getBlockByHeight(151),
      kyveApi.getBlockByHeight(300),
      kyveApi.getBlockByHeight(301),
    ]);

    const cachedBundles = await fs.promises.readdir(tmpPath);
    expect(cachedBundles.length).toBe(3);

    for (const bundle of (kyveApi as any).cachedBundleDetails) {
      const stats = await fs.promises.stat(
        (kyveApi as any).getBundleFilePath(bundle.id),
      );
      const permissions = (stats.mode & 0o777).toString(8);
      expect(permissions).toBe('444');
    }
  });
  it('retrieve and unzip storage data', async () => {
    const bundle = await (kyveApi as any).getBundleById(8);

    (kyveApi as any).cachedBundleDetails.push(bundle);

    const bundleFileName = (kyveApi as any).getBundleFilePath(bundle.id);
    await kyveApi.downloadAndProcessBundle(bundle);

    const v = await kyveApi.readFromFile(bundleFileName);

    const b = (kyveApi as any).findBlockByHeight(1338, JSON.parse(v));

    expect(b).toBeDefined();
  });
  it('Should increment bundleId when height exceeds cache', async () => {
    const bundle = await (kyveApi as any).getBundleById(0);
    (kyveApi as any).cachedBundleDetails.push(bundle);
    jest.spyOn(kyveApi as any, 'getFileCacheData').mockResolvedValueOnce('{}');
    await (kyveApi as any).updateCurrentBundleAndDetails(160);

    expect(
      (kyveApi as any).cachedBundleDetails.find((b) => b.id === '1'),
    ).toBeDefined();
  });
  it('compare block info', async () => {
    const height = 3901476;
    const tendermintBlockInfo = await tendermint.block(height);
    const [kyveBlockInfo] = await kyveApi.getBlockByHeight(height);
    expect(isEqual(tendermintBlockInfo, kyveBlockInfo)).toBe(true);
  });
  it('determine correct pool', async () => {
    const lcdClient = new KyveSDK(KYVE_CHAINID, {
      rpc: KYVE_ENDPOINT,
    }).createLCDClient();

    const poolId = await (KyveApi as any).fetchPoolId('archway-1', lcdClient);

    expect(poolId).toBe('2');
  });
  it('remove bundle.json if bundle fetch fails', async () => {
    const bundleDetail = await (kyveApi as any).getBundleById(8);
    (kyveApi as any).cachedBundleDetails = [bundleDetail];

    jest.spyOn(axios, 'isAxiosError').mockImplementationOnce(() => true);

    retrieveBundleDataSpy.mockImplementation(() => {
      return new Promise((resolve, reject) => {
        reject({
          response: 'err',
        });
      });
    });

    await expect(
      (kyveApi as any).getFileCacheData(bundleDetail),
    ).rejects.toBeDefined();

    const files = await fs.promises.readdir(tmpPath);
    expect(files.length).toBe(0);
  });
  it('remove cached bundle files when past height', async () => {
    await kyveApi.fetchBlocksBatches(registry, [1, 151, 301, 501], 300);
    await kyveApi.fetchBlocksBatches(registry, [502, 504, 600, 800], 300);

    const files = await fs.promises.readdir(tmpPath);
    expect(files).not.toContain('bundle_0.json');
    expect((kyveApi as any).cachedBundleDetails.length).toBe(4);
  });
  it('ensure to remove logic', () => {
    const cachedBundleDetails = [
      { id: '0', from_key: '1', to_key: '150' },
      { id: '1', from_key: '151', to_key: '300' },
      { id: '2', from_key: '301', to_key: '500' },
      { id: '3', from_key: '501', to_key: '800' },
    ] as BundleDetails[];
    (kyveApi as any).cachedBundleDetails = cachedBundleDetails;

    const height = 650;
    const bufferSize = 300;

    const toRemoveBundles = (kyveApi as any).getToRemoveBundles(
      cachedBundleDetails,
      height,
      bufferSize,
    );

    expect(toRemoveBundles.sort()).toEqual(
      [
        { id: '0', from_key: '1', to_key: '150' },
        { id: '1', from_key: '151', to_key: '300' },
      ].sort(),
    );
  });
  it('Able to poll with simulated workers', async () => {
    const bundleDetail = await (kyveApi as any).getBundleById(130265);
    (kyveApi as any).cachedBundleDetails = [bundleDetail];

    retrieveBundleDataSpy.mockImplementation(() => {
      return { data: mockStream };
    });

    const pollSpy = jest.spyOn(kyveApi as any, 'pollUntilReadable');
    await Promise.all([
      kyveApi.fetchBlocksBatches(registry, [3856726], 1),
      kyveApi.fetchBlocksBatches(registry, [3856726], 1),
      kyveApi.fetchBlocksBatches(registry, [3856726], 1),
      kyveApi.fetchBlocksBatches(registry, [3856726], 1),
    ]);

    expect(pollSpy).toHaveBeenCalledTimes(3);

    const r = await kyveApi.readFromFile(
      (kyveApi as any).getBundleFilePath(bundleDetail.id),
    );

    expect(r).toEqual(JSON.stringify(block_3856726));
  });
  describe('able to wrap kyveBlock', () => {
    let rpcLazyBlockContent: LazyBlockContent;
    let kyveLazyBlockContent: LazyBlockContent;
    let tendermintBlockInfo: BlockResponse;
    let tendermintBlockResult: BlockResultsResponse;

    beforeAll(async () => {
      const height = 3856726;
      [tendermintBlockInfo, tendermintBlockResult] = await Promise.all([
        tendermint.block(height),
        tendermint.blockResults(height),
      ]);

      const blockInfo = block_3856726[0].value.block;
      const blockResults = block_3856726[0].value.block_results;

      const bi = (kyveApi as any).decodeBlock(blockInfo);
      const br = (kyveApi as any).decodeBlockResult(blockResults);

      rpcLazyBlockContent = new LazyBlockContent(
        tendermintBlockInfo,
        tendermintBlockResult,
        registry,
      );
      kyveLazyBlockContent = new LazyBlockContent(bi, br, registry);
    });
    it('compare kyve wrapped results with rpc results', () => {
      const blockResults = block_3856726[0].value.block_results;

      const br = (kyveApi as any).decodeBlockResult(blockResults);

      const logs = (kyveApi as any).reconstructLogs(br);
      expect(logs.length).toBe(2);
      expect(logs[0].events.length).toBe(3);
      expect(logs[1].events.length).toBe(5);

      const reconstructedKyveBlock = (kyveApi as any).injectLogs(br);
      expect(reconstructedKyveBlock.results[0].log).toBeDefined();
    });
    it('wrapTransaction', () => {
      expect(kyveLazyBlockContent.transactions[0].tx.data.length).toBe(
        rpcLazyBlockContent.transactions[0].tx.data.length,
      );
      expect(kyveLazyBlockContent.transactions[0].tx.events.length).toBe(
        rpcLazyBlockContent.transactions[0].tx.events.length,
      );
      expect(kyveLazyBlockContent.transactions.length).toBe(
        rpcLazyBlockContent.transactions.length,
      );
    });
    it('wrapMessages', () => {
      kyveLazyBlockContent.messages.forEach((m, i) => {
        expect(m.msg).toEqual(rpcLazyBlockContent.messages[i].msg);
      });
    });
    it('wrapBlock', () => {
      expect(kyveLazyBlockContent.block.blockId.hash.length).toBe(
        rpcLazyBlockContent.block.blockId.hash.length,
      );
      expect(kyveLazyBlockContent.block.block.id).toBe(
        rpcLazyBlockContent.block.block.id,
      );
      expect(kyveLazyBlockContent.block.block.header).toEqual(
        rpcLazyBlockContent.block.block.header,
      );
    });
    it('wrapEvents', () => {
      kyveLazyBlockContent.events.forEach((e, i) => {
        const rpcEvent = rpcLazyBlockContent.events[i].event;
        expect(e.event.type).toBe(rpcEvent.type);
        expect(e.event.attributes.length).toBe(rpcEvent.attributes.length);
      });
    });
  });
});
