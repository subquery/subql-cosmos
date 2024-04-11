// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { promisify } from 'util';
import { gzipSync } from 'zlib';
import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
import KyveSDK from '@kyvejs/sdk';
import { makeTempDir } from '@subql/common';
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

  const zipped = gzipSync(Buffer.from(JSON.stringify(block_3856726)));
  const mockStream = new Readable({
    read() {
      this.push(zipped);
      this.push(null);
    },
  });

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
    retrieveBundleDataSpy = jest.spyOn(kyveApi as any, 'retrieveBundleData');
  });

  afterEach(() => {
    // reset cache
    (kyveApi as any).currentBundleId = -1;
    (kyveApi as any).cachedBundleDetails = undefined;
    (kyveApi as any).cachedBundle = undefined;
    (kyveApi as any).cachedBlocks = undefined;

    retrieveBundleDataSpy.mockRestore();
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
  it('retrieve and unzip storage data', async () => {
    const id = 8;
    (kyveApi as any).cachedBundleDetails = await (kyveApi as any).getBundleById(
      id,
    );

    const bundleFileName = (kyveApi as any).getBundleFilePath(id);
    await kyveApi.downloadAndProcessBundle(bundleFileName);

    const v = await kyveApi.readFromFile(bundleFileName);

    const b = (kyveApi as any).findBlockByHeight(1338, JSON.parse(v));

    expect(b).toBeDefined();
  });
  it('Should increment bundleId when height exceeds cache', async () => {
    (kyveApi as any).currentBundleId = 0;
    (kyveApi as any).cachedBundle = 'value';
    (kyveApi as any).cachedBundleDetails = {
      to_key: '150',
      storage_id: 'YLpTxtj_0ICoWq9HUEOx6VcIzKk8Qui1rnkhH4acbTU',
      compression_id: '1',
    } as any;
    await (kyveApi as any).updateCurrentBundleAndDetails(160);
    expect((kyveApi as any).currentBundleId).toBe(1);
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

    const poolId = await KyveApi.fetchPoolId('archway-1', lcdClient);

    expect(poolId).toBe('2');
  });
  it('able to update and clear file cache', async () => {
    const checkFileExist = async (filePath: string) => {
      try {
        await fs.promises.access(filePath);
        return true;
      } catch (e) {
        return false;
      }
    };

    // create two mock bundles
    await fs.promises.writeFile(path.join(tmpPath, 'bundle_130263'), 'mock'); // should be removed
    await fs.promises.writeFile(path.join(tmpPath, 'bundle_130264'), 'mock');

    retrieveBundleDataSpy = jest
      .spyOn(kyveApi as any, 'retrieveBundleData')
      .mockImplementation(() => {
        return { data: mockStream };
      });

    const clearFileSpy = jest.spyOn(kyveApi as any, 'clearFileCache');

    jest.spyOn(kyveApi as any, 'readFromFile').mockImplementation(() => {
      return Promise.resolve(JSON.stringify(block_3856726));
    });

    await kyveApi.getBlockByHeight(3856726);
    expect((kyveApi as any).cachedBundleDetails).not.toBe('0');

    await expect(
      checkFileExist(path.join(tmpPath, 'bundle_130263')),
    ).resolves.toBe(false);
    expect(clearFileSpy).toHaveBeenCalledTimes(1);
  });
  it('able to download and write to file', async () => {
    (kyveApi as any).cachedBundleDetails = await (kyveApi as any).getBundleById(
      1,
    );

    retrieveBundleDataSpy = jest
      .spyOn(kyveApi as any, 'retrieveBundleData')
      .mockImplementation(() => {
        return { data: mockStream };
      });

    const pollSpy = jest.spyOn(kyveApi as any, 'pollUntilReadable');

    await expect(
      Promise.all([
        kyveApi.getFileCacheData(),
        kyveApi.getFileCacheData(),
        kyveApi.getFileCacheData(),
        kyveApi.getFileCacheData(),
      ]),
    ).resolves.not.toThrow();

    expect(pollSpy).toHaveBeenCalled();

    const r = await kyveApi.readFromFile(
      (kyveApi as any).getBundleFilePath(
        (kyveApi as any).cachedBundleDetails.id,
      ),
    );

    const stats = await fs.promises.stat(
      (kyveApi as any).getBundleFilePath(
        (kyveApi as any).cachedBundleDetails.id,
      ),
    );

    const permissions = (stats.mode & 0o777).toString(8);

    expect(permissions).toBe('444');
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
