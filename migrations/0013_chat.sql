-- 0013_chat
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Coach Mochi sohbeti (docs/backend/03-veri-modeli.md §3.8, 09-yapay-zeka.md §2).
-- Öneri metinleri katalogda (catalog_items/labels, ad alanı chat_suggestion; F2).

CREATE TABLE chat_conversations (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  title              VARCHAR(120) NULL,
  is_pinned          TINYINT(1)   NOT NULL DEFAULT 0,
  message_count      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- Uzun sohbetlerde eski mesajların özeti (şifreli); bu mesaja kadar olanları kapsar.
  rolling_summary_enc VARBINARY(16384) NULL,
  summary_upto_message_id BINARY(16) NULL,
  summary_message_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  context_source     ENUM('direct', 'hunger_result', 'fasting_struggle', 'suggestion')
                     NOT NULL DEFAULT 'direct',
  -- Giriş noktasının kaydı (ör. açlık check-in'i id'si).
  context_ref        BINARY(16)   NULL,
  last_message_at    DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_conv_user_list (user_id, deleted_at, is_pinned, last_message_at),
  CONSTRAINT fk_conv_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE chat_messages (
  -- Kullanıcı mesajında istemci üretebilir (UUIDv7): tekrar gönderim yinelenmez.
  id                 BINARY(16)   NOT NULL,
  conversation_id    BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  role               ENUM('user', 'assistant') NOT NULL,
  -- Şifreli metin (kullanıcıya gösterilen).
  content_enc        MEDIUMBLOB   NOT NULL,
  -- Kullanıcı mesajında modele giden bağlam bloğu, birebir (prompt cache: geçmiş byte'ı byte'ına
  -- aynı yeniden kurulur).
  context_enc        VARBINARY(8192) NULL,
  status             ENUM('complete', 'streaming', 'interrupted', 'failed', 'refused')
                     NOT NULL DEFAULT 'complete',
  -- Acil durum sinyali (09 §5.2): istemci "acil durum" kartı gösterir.
  safety             ENUM('none', 'urgent') NOT NULL DEFAULT 'none',
  model              VARCHAR(64)  NULL,
  input_tokens       INT UNSIGNED NULL,
  output_tokens      INT UNSIGNED NULL,
  cache_read_tokens  INT UNSIGNED NULL,
  stop_reason        VARCHAR(32)  NULL,
  feedback           ENUM('up', 'down') NULL,
  feedback_reason    VARCHAR(200) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_msgs_conv_time (conversation_id, created_at),
  CONSTRAINT fk_msgs_conv FOREIGN KEY (conversation_id)
    REFERENCES chat_conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_msgs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
