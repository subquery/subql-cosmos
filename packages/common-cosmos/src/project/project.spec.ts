// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import path from 'path';
import {getManifestPath, loadFromJsonOrYaml} from '@subql/common';
import {validateCosmosManifest} from '../codegen/util';
<<<<<<< HEAD
import {CosmosProjectManifestVersioned, VersionedProjectManifest} from './versioned';
=======
import {loadCosmosProjectManifest, parseCosmosProjectManifest} from './load';
>>>>>>> dd005b73 (update class validator)

const projectsDir = path.join(__dirname, '../../test');

function loadCosmosProjectManifest(file: string): CosmosProjectManifestVersioned {
  const doc = loadFromJsonOrYaml(getManifestPath(file));
  const projectManifest = new CosmosProjectManifestVersioned(doc as VersionedProjectManifest);
  projectManifest.validate();
  return projectManifest;
}

describe('project.yaml', () => {
  it('can validate a v1.0.0 project.yaml', () => {
    expect(() => loadCosmosProjectManifest(path.join(projectsDir, 'project_1.0.0.yaml'))).not.toThrow();
  });

  it('can validate a v1.0.0 project.yaml with unsupported runner node', () => {
    expect(() => loadCosmosProjectManifest(path.join(projectsDir, 'project_1.0.0_bad_runner.yaml'))).toThrow();
  });
  it('assets should be validated', () => {
    expect(() =>
      loadCosmosProjectManifest(path.join(projectsDir, 'protoTest1', 'cosmwasm-project.yaml'))
    ).not.toThrow();
  });
  it('Should throw on invalid FileReference on asset', () => {
    expect(() =>
      loadCosmosProjectManifest(path.join(projectsDir, 'protoTest1', 'bad-abi-cosmos-project.yaml'))
    ).toThrow('- property dataSources[0].assets has failed the following constraints: isFileReference');
  });
  it('Ensure correctness on Cosmos Manifest validate', () => {
    const cosmosManifest = loadFromJsonOrYaml(path.join(projectsDir, './protoTest1', 'project.yaml')) as any;
    const ethManifest = loadFromJsonOrYaml(path.join(projectsDir, 'project_1.0.0_bad_runner.yaml')) as any;
    expect(validateCosmosManifest(cosmosManifest)).toBe(true);
    expect(validateCosmosManifest(ethManifest)).toBe(false);
  });
  it('Should fail on incorrect chaintypes', () => {
    const cosmosManifest = loadFromJsonOrYaml(
      path.join(projectsDir, './protoTest1', 'bad-chaintypes-project.yaml')
    ) as any;
    expect(() => parseCosmosProjectManifest(cosmosManifest)).toThrow('failed to parse project.yaml');
  });
  it('Ensure correctness on manifest deployment', () => {
    const cosmosManifest = loadFromJsonOrYaml(path.join(projectsDir, './protoTest1', 'project.yaml')) as any;
    const manifest = parseCosmosProjectManifest(cosmosManifest);
    console.log('delpoyment', manifest.toDeployment());
    expect(manifest.toDeployment()).toBe(
      'dataSources:\n' +
        '  - kind: cosmos/Runtime\n' +
        '    mapping:\n' +
        '      file: ./dist/index.js\n' +
        '      handlers:\n' +
        '        - filter:\n' +
        '            type: /osmosis.gamm.v1beta1.MsgSwapExactAmountIn\n' +
        '          handler: handleMessage\n' +
        '          kind: cosmos/MessageHandler\n' +
        '    startBlock: 9798050\n' +
        'network:\n' +
        '  chainId: osmosis-1\n' +
        '  chainTypes:\n' +
        '    cosmos.base.v1beta1:\n' +
        '      file: ./proto/cosmos/base/v1beta1/coin.proto\n' +
        '      messages:\n' +
        '        - Coin\n' +
        '    osmosis.gamm.v1beta1:\n' +
        '      file: ./proto/osmosis/gamm/v1beta1/tx.proto\n' +
        '      messages:\n' +
        '        - MsgSwapExactAmountIn\n' +
        '    osmosis.poolmanager.v1beta1:\n' +
        '      file: ./proto/osmosis/poolmanager/v1beta1/swap_route.proto\n' +
        '      messages:\n' +
        '        - SwapAmountInRoute\n' +
        'runner:\n' +
        '  node:\n' +
        "    name: '@subql/node-cosmos'\n" +
        "    version: '*'\n" +
        '  query:\n' +
        "    name: '@subql/query'\n" +
        "    version: '*'\n" +
        'schema:\n' +
        '  file: ./schema.graphql\n' +
        'specVersion: 1.0.0\n'
    );
  });
});
