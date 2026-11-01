-- Apply once to the app database before serving this block.
CREATE TABLE IF NOT EXISTS crm_pipeline (
  scope text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
