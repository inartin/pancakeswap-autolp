CREATE TABLE "terms_acceptance" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_telegram_id" integer NOT NULL,
	"tos_version" text NOT NULL,
	"tos_url" text NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL,
	"acceptance_method" text DEFAULT 'telegram_button' NOT NULL,
	CONSTRAINT "terms_acceptance_user_telegram_id_unique" UNIQUE("user_telegram_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_telegram_id" integer NOT NULL,
	"wallet_address" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"nonce" text NOT NULL,
	"salt" text NOT NULL,
	"label" text DEFAULT 'My Wallet' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_wallet_address_unique" UNIQUE("wallet_address")
);
