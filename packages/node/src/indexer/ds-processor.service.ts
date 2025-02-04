// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Injectable } from '@nestjs/common';
import { isCustomCosmosDs } from '@subql/common-cosmos';
import { BaseDsProcessorService } from '@subql/node-core';
import {
  CosmosCustomDatasource,
  CosmosDatasourceProcessor,
  CosmosDatasource,
} from '@subql/types-cosmos';

@Injectable()
export class DsProcessorService extends BaseDsProcessorService<
  CosmosDatasource,
  CosmosCustomDatasource<string>,
  CosmosDatasourceProcessor<string, Record<string, unknown>>
> {
  protected isCustomDs = isCustomCosmosDs;
}
