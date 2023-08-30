// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import path from 'path';
import {loadCosmosProjectManifest} from './load';

const projectsDir = path.join(__dirname, '../../test');

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
    ).toThrow('{"baseMinter":{"filePath":"./cosmwasm-contract/cw20/schema/cw20.json"}} is not a valid assets format');
  });
});
