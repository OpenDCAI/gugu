CREATE TABLE im_messages (
  rowid integer PRIMARY KEY NOT NULL,
  account_id text NOT NULL,
  id text NOT NULL,
  chat_id text NOT NULL,
  thread_root_id text,
  seq integer NOT NULL,
  sender_user_id text,
  created_at text NOT NULL,
  content_type text NOT NULL,
  content text,
  is_whisper integer NOT NULL,
  to_user_ids text NOT NULL,
  file_item_id text,
  rest text NOT NULL,
  claimed_revision text
);
--> statement-breakpoint
CREATE UNIQUE INDEX im_messages_account_id ON im_messages(account_id, id);
--> statement-breakpoint
CREATE INDEX im_messages_stream ON im_messages(account_id, chat_id, thread_root_id, seq);
--> statement-breakpoint
CREATE TABLE im_message_accounts (
  account_id text PRIMARY KEY NOT NULL,
  through_revision text NOT NULL
);
--> statement-breakpoint
CREATE TABLE im_message_tombstones (
  account_id text NOT NULL,
  chat_id text NOT NULL,
  message_id text NOT NULL,
  PRIMARY KEY (account_id, chat_id, message_id)
);
--> statement-breakpoint
CREATE TABLE im_message_chats (
  account_id text NOT NULL,
  chat_id text NOT NULL,
  source_chat_id text,
  own_member integer,
  membership_revoked integer NOT NULL DEFAULT 0,
  membership_revision text,
  chat_revision text,
  archived integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, chat_id)
);
--> statement-breakpoint
CREATE INDEX im_message_chats_source ON im_message_chats(account_id, source_chat_id, own_member);
--> statement-breakpoint
CREATE TABLE im_message_ranges (
  account_id text NOT NULL,
  chat_id text NOT NULL,
  thread_root_id text NOT NULL DEFAULT '',
  from_seq integer NOT NULL,
  to_seq integer NOT NULL,
  PRIMARY KEY (account_id, chat_id, thread_root_id, from_seq)
);
--> statement-breakpoint
CREATE VIRTUAL TABLE im_messages_text USING fts5(
  text, content='', contentless_delete=1, tokenize='trigram case_sensitive 0'
);
