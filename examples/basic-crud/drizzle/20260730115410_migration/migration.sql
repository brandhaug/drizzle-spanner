CREATE TABLE `tasks` (
  `id` STRING(36) NOT NULL DEFAULT (GENERATE_UUID()),
  `title` STRING(MAX) NOT NULL,
  `done` BOOL NOT NULL DEFAULT (FALSE),
  `updated_at` TIMESTAMP OPTIONS (allow_commit_timestamp = true)
) PRIMARY KEY (`id`);
