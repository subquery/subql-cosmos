// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { IBlockDispatcher } from '@subql/node-core';
import { BlockContent } from '../types';

export interface ICosmosBlockDispatcher extends IBlockDispatcher<BlockContent> {
  init(
    onDynamicDsCreated: (height: number) => void | Promise<void>,
  ): Promise<void>;
}
