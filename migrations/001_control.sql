CREATE TABLE IF NOT EXISTS cloud_projects (
  id VARCHAR(64) PRIMARY KEY, name VARCHAR(200) NOT NULL,
  created_at BIGINT NOT NULL, bootstrapped_at BIGINT NULL
);
CREATE TABLE IF NOT EXISTS cloud_api_keys (
  id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL, role VARCHAR(16) NOT NULL,
  prefix VARCHAR(24) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL, expires_at BIGINT NULL, revoked_at BIGINT NULL,
  INDEX cloud_keys_project (project_id, role)
);
CREATE TABLE IF NOT EXISTS cloud_sessions (
  token_hash CHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
  api_key_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL, INDEX cloud_sessions_expiry (expires_at)
);
CREATE TABLE IF NOT EXISTS cloud_function_versions (
  project_id VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL,
  version INT NOT NULL, worker_group VARCHAR(128) NOT NULL,
  description TEXT NOT NULL, input_schema LONGTEXT NOT NULL,
  descriptor_hash CHAR(64) NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, name, version)
);
CREATE TABLE IF NOT EXISTS cloud_workers (
  project_id VARCHAR(64) NOT NULL, id VARCHAR(128) NOT NULL,
  api_key_id VARCHAR(64) NOT NULL, worker_group VARCHAR(128) NOT NULL,
  functions_json TEXT NOT NULL, last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL, PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS cloud_audit_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, project_id VARCHAR(64) NOT NULL,
  api_key_id VARCHAR(64) NOT NULL, action VARCHAR(64) NOT NULL,
  target VARCHAR(200) NOT NULL, created_at BIGINT NOT NULL,
  INDEX cloud_audit_project (project_id, created_at)
);
