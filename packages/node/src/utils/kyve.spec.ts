// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { isEqual } from 'lodash';
import { HttpClient } from '../indexer/rpc-clients';
import { KyveApi } from './kyve';

jest.setTimeout(100000);
describe('KyveClient', () => {
  let kyveApi: KyveApi;
  beforeAll(async () => {
    kyveApi = new KyveApi('archway-1');
    await kyveApi.init();
  });

  it('ensure correct bundle ID on binary search', async () => {
    const a = Date.now();
    const v = await (kyveApi as any).getBundleId(3489747); // https://app.kyve.network/#/pools/2/bundles/5149474
    const b = Date.now();
    console.log(`${b - a}ms`);
    expect(v).toBe(113773);
  });
  it('block structure matches tendermint37 client', async () => {
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
    expect(
      tendermintBlockResult.beginBlockEvents[4].attributes.find(
        (a) => a.key === 'c2VuZGVy',
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
        (a) => a.key === 'cmVjaXBpZW50',
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
