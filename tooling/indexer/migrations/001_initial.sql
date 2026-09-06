CREATE TABLE chains (
    chain_id TEXT PRIMARY KEY NOT NULL,
    genesis_block_hash TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE kernels (
    chain_id TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    world_id_filter TEXT,
    start_block TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    confirmations TEXT NOT NULL,
    chunk_size TEXT NOT NULL,
    max_reorg_depth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (chain_id, kernel_address),
    FOREIGN KEY (chain_id) REFERENCES chains(chain_id)
) STRICT;

CREATE TABLE blocks (
    chain_id TEXT NOT NULL,
    block_number TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
    finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
    first_seen_at TEXT NOT NULL,
    orphaned_at TEXT,
    PRIMARY KEY (chain_id, block_hash),
    FOREIGN KEY (chain_id) REFERENCES chains(chain_id)
) STRICT;

CREATE UNIQUE INDEX blocks_one_canonical_height
    ON blocks(chain_id, block_number) WHERE canonical = 1;
CREATE INDEX blocks_canonical_number ON blocks(chain_id, canonical, block_number);

CREATE TABLE vm_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    block_number TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index TEXT NOT NULL,
    ethereum_log_index TEXT NOT NULL,
    world_id TEXT NOT NULL,
    execution_height TEXT NOT NULL,
    raw_log_data TEXT NOT NULL,
    raw_receipt_payload TEXT NOT NULL,
    receipt_version INTEGER NOT NULL,
    receipt_flags INTEGER NOT NULL,
    canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
    finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
    indexed_at TEXT NOT NULL,
    FOREIGN KEY (chain_id, kernel_address) REFERENCES kernels(chain_id, kernel_address),
    FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash),
    UNIQUE (chain_id, kernel_address, block_hash, transaction_hash, ethereum_log_index)
) STRICT;

CREATE UNIQUE INDEX executions_one_canonical_height
    ON vm_executions(chain_id, kernel_address, world_id, execution_height) WHERE canonical = 1;
CREATE INDEX executions_canonical_order
    ON vm_executions(chain_id, kernel_address, canonical, block_number, transaction_index, ethereum_log_index);

CREATE TABLE vm_records (
    execution_id INTEGER NOT NULL,
    event_index INTEGER NOT NULL CHECK (event_index >= 0 AND event_index < 64),
    emitter TEXT NOT NULL,
    topic_count INTEGER NOT NULL CHECK (topic_count >= 0 AND topic_count <= 4),
    topic0 TEXT,
    topic1 TEXT,
    topic2 TEXT,
    topic3 TEXT,
    raw_data TEXT NOT NULL,
    kernel_record_kind TEXT NOT NULL CHECK (
        kernel_record_kind IN ('application', 'world_execution', 'mini_contract_deployed')
    ),
    canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
    finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
    PRIMARY KEY (execution_id, event_index),
    FOREIGN KEY (execution_id) REFERENCES vm_executions(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE program_deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    event_index INTEGER NOT NULL,
    chain_id TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    world_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    creator TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
    finalized INTEGER NOT NULL CHECK (finalized IN (0, 1)),
    FOREIGN KEY (execution_id, event_index) REFERENCES vm_records(execution_id, event_index),
    UNIQUE (execution_id, event_index)
) STRICT;

CREATE UNIQUE INDEX deployments_one_canonical_contract
    ON program_deployments(chain_id, kernel_address, world_id, contract_id) WHERE canonical = 1;
CREATE INDEX deployments_canonical_lookup
    ON program_deployments(chain_id, kernel_address, world_id, canonical, contract_id);

CREATE TABLE ingestion_cursor (
    chain_id TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    next_block TEXT NOT NULL,
    last_canonical_block_hash TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (chain_id, kernel_address),
    FOREIGN KEY (chain_id, kernel_address) REFERENCES kernels(chain_id, kernel_address)
) STRICT;

CREATE TABLE ingestion_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    block_number TEXT,
    block_hash TEXT,
    transaction_hash TEXT,
    ethereum_log_index TEXT,
    category TEXT NOT NULL CHECK (category IN ('EVENTS', 'RECEIPT', 'INTEGRITY', 'RPC', 'REORG')),
    error_code TEXT NOT NULL,
    error_details TEXT NOT NULL,
    raw_log_json TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    retryable INTEGER NOT NULL CHECK (retryable IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX ingestion_errors_identity
    ON ingestion_errors(
        chain_id,
        kernel_address,
        ifnull(block_hash, ''),
        ifnull(transaction_hash, ''),
        ifnull(ethereum_log_index, ''),
        error_code
    );
