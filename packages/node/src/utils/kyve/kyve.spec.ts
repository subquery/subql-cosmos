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
import { delay } from '@subql/node-core';
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
  '../../../test/kyve_block/block_4326863.json',
);
const block_4326863 = require(kyveBundlePath);

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
  let getBundleDataSpy: jest.SpyInstance;

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
      300,
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
    getBundleDataSpy = jest.spyOn(kyveApi as any, 'getBundleData');

    zippedMockResp = gzipSync(Buffer.from(JSON.stringify(block_4326863)));
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
    getBundleDataSpy.mockRestore();

    // reset cache
    ((kyveApi as any).cachedBundleDetails as Record<
      string,
      Promise<BundleDetails>
    >) = {};
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
    const firstBundle = await (kyveApi as any).getBundleIdSearch(120); // https://app.kyve.network/#/pools/2/bundles/0
    const b = Date.now();
    console.log(`${b - a}ms`);

    const laterBundle = await (kyveApi as any).getBundleIdSearch(3489747); // https://app.kyve.network/#/pools/2/bundles/5149474
    expect(firstBundle).toBe(0);
    expect(laterBundle).toBe(113773);
  });
  it('Ensure bundleId is defined', async () => {
    getBundleDataSpy.mockResolvedValue(JSON.stringify({ mock: 'value' }));

    await Promise.all([
      (kyveApi as any).updateCurrentBundleAndDetails(1),
      (kyveApi as any).updateCurrentBundleAndDetails(150),
      (kyveApi as any).updateCurrentBundleAndDetails(151),
      (kyveApi as any).updateCurrentBundleAndDetails(500),
      (kyveApi as any).updateCurrentBundleAndDetails(1000),
      (kyveApi as any).updateCurrentBundleAndDetails(2500),
    ]);

    expect(getBundleDataSpy).toHaveBeenCalledTimes(6);
    expect(getBundleDataSpy).not.toHaveBeenCalledWith(undefined);
  });
  it('Concurrent fetch with incrementing bundle id', async () => {
    // should increment from bundle id 8 to 9 only calling binary search once
    const binarySearchSpy = jest.spyOn(kyveApi as any, 'getBundleIdSearch');
    await Promise.all([
      kyveApi.getBlockByHeight(1338),
      kyveApi.getBlockByHeight(1339),
      kyveApi.getBlockByHeight(1350),
      kyveApi.getBlockByHeight(1351),
    ]);
    const batch2 = await Promise.all([
      kyveApi.getBlockByHeight(1500),
      kyveApi.getBlockByHeight(1501),
      kyveApi.getBlockByHeight(4000),
    ]);
    expect((kyveApi as any).cachedBundleDetails[10]).toBeDefined();
    expect(binarySearchSpy).toHaveBeenCalledTimes(4);
    expect(batch2.length).toBe(3);
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

    const blocks = await Promise.all([
      kyveApi.getBlockByHeight(1),
      kyveApi.getBlockByHeight(151),
      kyveApi.getBlockByHeight(151),
      kyveApi.getBlockByHeight(300),
      kyveApi.getBlockByHeight(301),
    ]);

    const cachedBundles = await fs.promises.readdir(tmpPath);
    expect(cachedBundles.length).toBe(3);
    expect(blocks.length).toBe(5);

    const bundles = (await Promise.all([
      (kyveApi as any).getBundleById(0),
      (kyveApi as any).getBundleById(1),
      (kyveApi as any).getBundleById(2),
    ])) as BundleDetails[];

    // Because somethings in the cache bundle doesn't mean its downloaded or on disc
    for (const bundle of bundles) {
      const stats = await fs.promises.stat(
        (kyveApi as any).getBundleFilePath(bundle.id),
      );
      const permissions = (stats.mode & 0o777).toString(8);
      expect(permissions).toBe('444');
    }
  });
  it('able to fetch/write/read blocks using Kyve api', async () => {
    const heights_1 = [150, 300, 1, 301, 450, 550];
    const heights_2 = [498, 600, 801, 1100];
    const blockArr = await Promise.all([
      kyveApi.fetchBlocksBatches(registry, heights_1),
      kyveApi.fetchBlocksBatches(registry, heights_2),
    ]);

    blockArr.forEach((blockContent) => {
      blockContent.forEach((b) => {
        expect(b.block instanceof LazyBlockContent).toBe(true);
      });
    });

    const files = await fs.promises.readdir(tmpPath);
    expect(files).not.toContain('bundle_2_0.json');
  });
  it('Able to clear stale files', async () => {
    const bundlePath = (kyveApi as any).getBundleFilePath(0);
    await fs.promises.writeFile(bundlePath, 'mock');
    await fs.promises.chmod(bundlePath, 0o200);

    await (KyveApi as any).clearStaleFiles(tmpPath, '2');

    const isExist = await fs.promises
      .access(bundlePath)
      .then(() => true)
      .catch(() => false);
    expect(isExist).toBe(false);
  });
  it('Should increment bundleId when height exceeds cache', async () => {
    (kyveApi as any).cachedBundleDetails[0] = (kyveApi as any).getBundleById(0);
    jest.spyOn(kyveApi as any, 'getBundleData').mockResolvedValueOnce('{}');
    await (kyveApi as any).updateCurrentBundleAndDetails(160);

    expect((kyveApi as any).cachedBundleDetails['1']).toBeDefined();
  });
  it('compare block info', async () => {
    const height = 4282099;
    const tendermintBlockInfo = await tendermint.block(height);
    const [kyveBlockInfo] = await kyveApi.getBlockByHeight(height);
    expect(isEqual(tendermintBlockInfo, kyveBlockInfo)).toBe(true);
  });
  it('Compare reconstructed logs and RPC logs', async () => {
    const height = 4284742;

    const blocks = await (kyveApi as any).updateCurrentBundleAndDetails(height);
    const blockData = (kyveApi as any).findBlockByHeight(height, blocks);

    const blockRes = (kyveApi as any).decodeBlockResult(
      blockData.value.block_results,
    );
    const reconstructedKyveBlock = (kyveApi as any).injectLogs(blockRes);

    expect(JSON.parse(reconstructedKyveBlock.results[0].log).length).toBe(1);
    expect(JSON.parse(reconstructedKyveBlock.results[1].log).length).toBe(1);

    expect(
      reconstructedKyveBlock.results[0].log.includes(
        'wasm-astrovault-ratio_pool_factory-update_direct_ratios',
      ) && !reconstructedKyveBlock.results[0].log.includes('ibc_transfer'),
    ).toBe(true);
  });
  it('determine correct pool', async () => {
    const lcdClient = new KyveSDK(KYVE_CHAINID, {
      rpc: KYVE_ENDPOINT,
    }).createLCDClient();

    const poolId = await (KyveApi as any).fetchPoolId('archway-1', lcdClient);

    expect(poolId).toBe('2');
  });
  it('remove bundle.json if bundle fetch fails', async () => {
    (kyveApi as any).cachedBundleDetails = {
      '8': (kyveApi as any).getBundleById(8),
    };

    jest.spyOn(axios, 'isAxiosError').mockImplementationOnce(() => true);

    retrieveBundleDataSpy.mockImplementation(() => {
      return new Promise((resolve, reject) => {
        reject('Failed to fetch');
      });
    });

    const bundleDetails = await (kyveApi as any).cachedBundleDetails['8'];
    await expect((kyveApi as any).getBundleData(bundleDetails)).rejects.toBe(
      'Failed to fetch',
    );

    const files = await fs.promises.readdir(tmpPath);
    expect(files.length).toBe(0);
  });
  it('ensure to remove logic', async () => {
    const mockCachedBundles: Record<string, Promise<BundleDetails>> = {
      '0': (kyveApi as any).getBundleById(0),
      '1': (kyveApi as any).getBundleById(1),
      '2': (kyveApi as any).getBundleById(2),
      '3': (kyveApi as any).getBundleById(3),
      '4': (kyveApi as any).getBundleById(4),
    };

    (kyveApi as any).cachedBundleDetails = mockCachedBundles;

    const height = 650;
    const bufferSize = 300;

    const toRemoveBundles = await (kyveApi as any).getToRemoveBundles(
      mockCachedBundles,
      height,
      bufferSize,
    );

    expect(toRemoveBundles.sort().map((b) => b.id)).toEqual(['0', '1'].sort());
  });
  it('Able to poll with simulated workers', async () => {
    const mockCacheDetails = {
      '151003': (kyveApi as any).getBundleById(151003),
    };
    (kyveApi as any).cachedBundleDetails = mockCacheDetails;

    const workerKyveApi = await KyveApi.create(
      'archway-1',
      KYVE_ENDPOINT,
      KYVE_STORAGE_URL,
      KYVE_CHAINID,
      tmpPath,
      1,
    );

    (workerKyveApi as any).cachedBundleDetails = mockCacheDetails;

    jest
      .spyOn(workerKyveApi, 'downloadAndProcessBundle')
      .mockImplementation(async (bundle: BundleDetails) => {
        await delay(2);
        return kyveApi.downloadAndProcessBundle(bundle);
      });

    jest
      .spyOn(workerKyveApi as any, 'retrieveBundleData')
      .mockImplementation(() => {
        return { data: mockStream };
      });

    retrieveBundleDataSpy.mockImplementation(() => {
      return { data: mockStream };
    });

    const pollSpy = jest.spyOn(workerKyveApi as any, 'pollUntilReadable');
    await Promise.all([
      kyveApi.fetchBlocksBatches(registry, [4326863]),
      workerKyveApi.fetchBlocksBatches(registry, [4326863]),
    ]);

    expect(pollSpy).toHaveBeenCalledTimes(1);

    const r = await kyveApi.readFromFile(
      (kyveApi as any).getBundleFilePath('151003'),
    );

    expect(r).toEqual(JSON.stringify(block_4326863));
  });
  it('isBundle', () => {
    const bundle = 'bundle_2_0.json';
    const notBundle = 'data.json';

    expect((KyveApi as any).isBundleFile(bundle, '2')).toBe(true);
    expect((KyveApi as any).isBundleFile(notBundle, '2')).toBe(false);
  });
  it('clear existing bundle files in directory when outside buffer', async () => {
    await fs.promises.writeFile((kyveApi as any).getBundleFilePath(0), 'mock');
    await fs.promises.writeFile((kyveApi as any).getBundleFilePath(1), 'mock');

    const removeFiles = await (kyveApi as any).getToRemoveBundles([], 800, 1);

    expect(removeFiles.map((r) => r.id).sort()).toEqual(['0', '1'].sort());
  });
  it('ensure file bundle id regex is correct', () => {
    const files = [
      'bundle_2_0.json',
      'bundle_2_1.json',
      'bundle_2_2.json',
      'bundle_2_3.json',
      'bundle_5_0.json',
      'bundle_4_0.json',
      'bundle_3_0.json',
      'bundle_1_0.json',
    ];

    expect(
      files.filter((f) => (KyveApi as any).isBundleFile(f, '2')).length,
    ).toBe(4);
  });
  describe('able to wrap kyveBlock', () => {
    let rpcLazyBlockContent: LazyBlockContent;
    let kyveLazyBlockContent: LazyBlockContent;
    let tendermintBlockInfo: BlockResponse;
    let tendermintBlockResult: BlockResultsResponse;

    beforeAll(async () => {
      const height = 4326863;
      [tendermintBlockInfo, tendermintBlockResult] = await Promise.all([
        tendermint.block(height),
        tendermint.blockResults(height),
      ]);

      const blockInfo = block_4326863[0].value.block;
      const blockResults = block_4326863[0].value.block_results;

      const bi = (kyveApi as any).decodeBlock(blockInfo);
      const br = (kyveApi as any).decodeBlockResult(blockResults);

      rpcLazyBlockContent = new LazyBlockContent(
        tendermintBlockInfo,
        tendermintBlockResult,
        registry,
      );
      kyveLazyBlockContent = new LazyBlockContent(bi, br, registry);
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
