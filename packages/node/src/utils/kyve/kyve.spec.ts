// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import path from 'path';
import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
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
  '../../../test/kyve_block/bundle.json',
);
const bundle_3856726 = require(kyveBundlePath);

jest.setTimeout(100000);
describe('KyveApi', () => {
  let kyveApi: KyveApi;
  let tendermint: Tendermint37Client;
  let registry: Registry;

  beforeAll(async () => {
    registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);
    kyveApi = await KyveApi.create(
      'archway-1',
      'https://rpc-eu-1.kyve.network',
      'https://arweave.net',
      'kyve-1',
    );
    const client = new HttpClient('https://rpc.mainnet.archway.io:443');
    tendermint = await Tendermint37Client.create(client);
  });

  // TODO: all the test to fetch bundle from arweave is failing on timeout.
  it('getBundle by height', async () => {
    const [, blockResponse] = await kyveApi.getBlockByHeight(3856726);
    expect(blockResponse).toEqual(bundle_3856726);
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
  it('retreive and unzip storage data', async () => {
    // const data = await (kyveApi as any).retrieveBundleData(
    //     'YLpTxtj_0ICoWq9HUEOx6VcIzKk8Qui1rnkhH4acbTU',
    //     100000
    // )
    console.log('ji test ');
    const d = await axios.get(
      'https://arweave.net/YLpTxtj_0ICoWq9HUEOx6VcIzKk8Qui1rnkhH4acbTU',
      {
        headers: {
          'User-Agent': `SubQuery-Node 3.9.2`,
          Connection: 'keep-alive',
          'Content-Encoding': 'gzip',
          'Content-Type': 'application/gzip',
        },
        timeout: 60000,
      },
    );
    console.log('!!?!');
    console.log('claimed data');
    // const unzipped = await (kyveApi as any).unzipStorageData('1', data)
    // console.log(unzipped)
  });
  it('Should increment bundleId when height exceeds cache', async () => {
    (kyveApi as any).currentBundleId = 0;
    (kyveApi as any).cachedBundle = 'value';

    await (kyveApi as any).validateCache(160, { to_key: '150' } as any);

    expect((kyveApi as any).currentBundleId).toBe(1);
  });
  it('compare block info', async () => {
    const height = 3901476;
    const tendermintBlockInfo = await tendermint.block(height);
    const [kyveBlockInfo] = await kyveApi.getBlockByHeight(height);
    expect(isEqual(tendermintBlockInfo, kyveBlockInfo)).toBe(true);
  });
  it('determine correct pool', () => {
    expect((kyveApi as any).poolId).toBe('2');
    expect((kyveApi as any).chainId).toBe('archway-1');
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

      const blockInfo = bundle_3856726.value.block;
      const blockResults = bundle_3856726.value.block_results;

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
      const blockResults = bundle_3856726.value.block_results;

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
