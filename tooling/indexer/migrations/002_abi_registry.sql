CREATE TABLE abi_registry (
    registry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL,
    artifact_abi_hash TEXT,
    descriptor_hash TEXT NOT NULL,
    interface_id TEXT,
    standard TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    trust_level TEXT NOT NULL CHECK (trust_level IN ('verified_reference', 'declared_unverified')),
    descriptor_json TEXT NOT NULL,
    artifact_source TEXT,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    UNIQUE (code_hash, descriptor_hash, trust_level)
) STRICT;

CREATE INDEX abi_registry_code_hash
    ON abi_registry(code_hash, enabled, trust_level);

CREATE TABLE program_abi_bindings (
    deployment_id INTEGER PRIMARY KEY NOT NULL,
    chain_id TEXT NOT NULL,
    kernel_address TEXT NOT NULL,
    world_id TEXT NOT NULL,
    emitter TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    registry_id INTEGER,
    trust_level TEXT NOT NULL CHECK (trust_level IN ('verified_reference', 'declared_unverified', 'unknown')),
    binding_status TEXT NOT NULL CHECK (binding_status IN ('bound', 'unknown', 'ambiguous')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (deployment_id) REFERENCES program_deployments(id) ON DELETE CASCADE,
    FOREIGN KEY (registry_id) REFERENCES abi_registry(registry_id)
) STRICT;

CREATE INDEX program_abi_bindings_identity
    ON program_abi_bindings(chain_id, kernel_address, world_id, emitter, code_hash);

CREATE TABLE decoded_events (
    execution_id INTEGER NOT NULL,
    event_index INTEGER NOT NULL,
    deployment_id INTEGER,
    registry_id INTEGER,
    event_signature TEXT,
    topic0 TEXT,
    decoder_version INTEGER NOT NULL,
    decoded_json TEXT,
    decode_status TEXT NOT NULL CHECK (
        decode_status IN ('decoded', 'unknown_program', 'unknown_event', 'failed', 'ambiguous')
    ),
    decoded_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, event_index),
    FOREIGN KEY (execution_id, event_index) REFERENCES vm_records(execution_id, event_index) ON DELETE CASCADE,
    FOREIGN KEY (deployment_id) REFERENCES program_deployments(id) ON DELETE SET NULL,
    FOREIGN KEY (registry_id) REFERENCES abi_registry(registry_id)
) STRICT;

CREATE INDEX decoded_events_selector
    ON decoded_events(topic0, event_signature, decode_status);

CREATE TABLE decoded_event_fields (
    execution_id INTEGER NOT NULL,
    event_index INTEGER NOT NULL,
    field_index INTEGER NOT NULL CHECK (field_index >= 0),
    field_name TEXT NOT NULL,
    field_type TEXT NOT NULL CHECK (field_type IN ('uint256', 'int256', 'bool', 'bytes32', 'account', 'address')),
    indexed INTEGER NOT NULL CHECK (indexed IN (0, 1)),
    field_position INTEGER NOT NULL CHECK (field_position >= 0),
    normalized_value TEXT NOT NULL,
    raw_value TEXT NOT NULL,
    account_kind TEXT CHECK (account_kind IN ('zero', 'EOA', 'contract', 'Kernel', 'unknown-tag')),
    PRIMARY KEY (execution_id, event_index, field_index),
    FOREIGN KEY (execution_id, event_index) REFERENCES decoded_events(execution_id, event_index) ON DELETE CASCADE
) STRICT;

CREATE INDEX decoded_event_fields_lookup
    ON decoded_event_fields(field_name, normalized_value, field_type);

CREATE TABLE event_decode_errors (
    execution_id INTEGER NOT NULL,
    event_index INTEGER NOT NULL,
    registry_id INTEGER,
    error_code TEXT NOT NULL,
    error_details TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    occurrences INTEGER NOT NULL CHECK (occurrences > 0),
    FOREIGN KEY (execution_id, event_index) REFERENCES vm_records(execution_id, event_index) ON DELETE CASCADE,
    FOREIGN KEY (registry_id) REFERENCES abi_registry(registry_id)
) STRICT;

CREATE UNIQUE INDEX event_decode_errors_identity
    ON event_decode_errors(execution_id, event_index, ifnull(registry_id, -1), error_code);
