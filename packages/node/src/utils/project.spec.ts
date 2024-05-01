// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { makeTempDir } from '@subql/common';
import { isTmpDir } from './project';

describe('Project tests', () => {
  it('ensure isTmpDir', async () => {
    const tmpDir = await makeTempDir();
    expect(isTmpDir(tmpDir)).toBe(true);
  });
  it('Not isTmpDir', () => {
    const unixDir = '/Users/test/';
    const winDir = 'C:\\Users\\test\\';
    expect(isTmpDir(unixDir)).toBe(false);
    expect(isTmpDir(winDir)).toBe(false);
  });
});
