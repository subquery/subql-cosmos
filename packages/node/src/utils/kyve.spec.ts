// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import {
  MsgClearAdmin,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgMigrateContract,
  MsgStoreCode,
  MsgUpdateAdmin,
} from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { isEqual } from 'lodash';
import { CosmosClient } from '../indexer/api.service';
import { HttpClient } from '../indexer/rpc-clients';
import { LazyBlockContent } from './cosmos';
import { KyveApi } from './kyve';

jest.setTimeout(100000);
describe('KyveClient', () => {
  let kyveApi: KyveApi;

  it('getBundle by height', async () => {
    kyveApi = new KyveApi('archway-1');
    await kyveApi.init();
    const v = await kyveApi.getBlockByHeight(3856726);
    // todo expect // timing out
    // expect(v).toEqual()
  });
  it('ensure correct bundle ID on binary search', async () => {
    kyveApi = new KyveApi('archway-1');
    await kyveApi.init();

    const a = Date.now();
    const laterBundle = await (kyveApi as any).getBundleId(3489747); // https://app.kyve.network/#/pools/2/bundles/5149474
    const b = Date.now();
    console.log(`${b - a}ms`);

    const firstBundle = await (kyveApi as any).getBundleId(120); // https://app.kyve.network/#/pools/2/bundles/0
    expect(firstBundle).toBe(0);
    expect(laterBundle).toBe(113773);
  });
  it('cosmos client with kyve', async () => {
    kyveApi = new KyveApi('archway-1');
    await kyveApi.init();

    const client = new HttpClient('https://rpc.mainnet.archway.io:443');
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
    const api = new CosmosClient(tendermint, registry);
    // const height = 3489747;
    const height = 1338;
    //
    const [kyveBlockInfo, kyveBlockResult] = await kyveApi.getBlockByHeight(
      height,
    );
    const [tendermintBlockInfo, tendermintBlockResult] = await Promise.all([
      tendermint.block(height),
      tendermint.blockResults(height),
    ]);

    const v = new LazyBlockContent(kyveBlockInfo, kyveBlockResult, api);
    const tv = new LazyBlockContent(
      tendermintBlockInfo,
      tendermintBlockResult,
      api,
    );
    // TODO
  });
  it('compare block info', async () => {
    const height = 13885474;

    const client = new HttpClient('https://rpc.osmosis.zone:443');
    const tendermint = await Tendermint37Client.create(client);

    kyveApi = new KyveApi('osmosis-1');
    await kyveApi.init();

    const tendermintBlockInfo = await tendermint.block(height);
    const [kyveBlockInfo] = await kyveApi.getBlockByHeight(height);
    expect(isEqual(tendermintBlockInfo, kyveBlockInfo)).toBe(true);
  });
  it('compare block results', async () => {
    kyveApi = new KyveApi('archway-1');
    await kyveApi.init();

    const client = new HttpClient('https://rpc.mainnet.archway.io:443');
    const tendermint = await Tendermint37Client.create(client);
    const height = 3489747;

    const [tendermintBlockInfo, tendermintBlockResult] = await Promise.all([
      tendermint.block(height),
      tendermint.blockResults(height),
    ]);
    const [kyveBlockInfo, kyveBlockResult] = await kyveApi.getBlockByHeight(
      height,
    );

    expect(isEqual(tendermintBlockInfo, kyveBlockInfo)).toBe(true);

    // Note: block result will fail on expect due to deep nested array order being wrong
    // RPC uses base64 decoded, due to recent upgrade.
    // However, kyve stores base64 encoded
    expect(
      tendermintBlockResult.beginBlockEvents[4].attributes.find(
        (a) => a.key === 'sender',
      ),
    ).toEqual(
      kyveBlockResult.beginBlockEvents[4].attributes.find(
        (a) => a.key === 'c2VuZGVy',
      ),
    );
    expect(
      isEqual(
        tendermintBlockResult.consensusUpdates,
        kyveBlockResult.consensusUpdates,
      ),
    ).toBe(true);
    expect(tendermintBlockResult.results.length).toBe(
      kyveBlockResult.results.length,
    );
    expect(tendermintBlockResult.validatorUpdates.length).toBe(
      kyveBlockResult.validatorUpdates.length,
    );
    expect(tendermintBlockResult.height).toBe(kyveBlockResult.height);

    expect(
      tendermintBlockResult.endBlockEvents[2].attributes.find(
        (a) => a.key === 'recipient',
      ),
    ).toEqual(
      kyveBlockResult.endBlockEvents[2].attributes.find(
        (a) => a.key === 'cmVjaXBpZW50',
      ),
    );
  });
  it('determine correct pool', () => {
    expect((kyveApi as any).poolId).toBe('2');
    expect((kyveApi as any).chainId).toBe('archway-1');
  });
});
