// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

// Note: this is due to incorrect typings provided by kyvejs
// https://github.com/KYVENetwork/kyvejs/issues/131
export interface BundleDetails {
  pool_id: string;
  id: string;
  storage_id: string;
  uploader: string;
  from_index: string;
  to_index: string;
  from_key: string;
  to_key: string;
  bundle_summary: string;
  data_hash: string;
  finalized_at: FinalizedAt;
  storage_provider_id: string;
  compression_id: string;
  stake_security: StakeSecurity;
}

interface FinalizedAt {
  height: string;
  timestamp: string;
}

interface StakeSecurity {
  valid_vote_power: string;
  total_vote_power: string;
}
