// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { StorageReceipt } from '@kyvejs/protocol';
import axios, { AxiosRequestConfig } from 'axios';

interface IStorageRetriever {
  retrieveBundle(storageId: string, timeout: number): Promise<StorageReceipt>;
}

export class StorageRetriever implements IStorageRetriever {
  private readonly storageUrl: string;
  constructor(url: string) {
    this.storageUrl = url;
  }
  async retrieveBundle(
    storageId: string,
    timeout: number,
  ): Promise<StorageReceipt> {
    const axiosConfig: AxiosRequestConfig = {
      method: 'get',
      url: `/${storageId}`,
      baseURL: this.storageUrl,
      responseType: 'arraybuffer',
      timeout,
    };
    const { data: storageData } = await axios(axiosConfig);

    return { storageId, storageData };
  }
}
