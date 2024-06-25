// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {INetworkCommonModule, ProjectManifestV1_0_0} from '@subql/types-core';
import {Data} from 'ejs';
import {CosmosCustomDatasource, CosmosDatasource, CosmosRuntimeDatasource} from './project';

export interface CosmosNetworkModule
  extends INetworkCommonModule<CosmosDatasource, CosmosRuntimeDatasource, CosmosCustomDatasource> {
  projectCodegen(
    manifest: ProjectManifestV1_0_0[],
    projectPath: string,
    prepareDirPath: (path: string, recreate: boolean) => Promise<void>,
    renderTemplate: (templatePath: string, outputPath: string, templateData: Data) => Promise<void>,
    upperFirst: (string?: string) => string,
    datasources: CosmosRuntimeDatasource[]
  ): Promise<void>;
}
