CREATE TABLE `pair_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pair_results` (
	`room_id` text NOT NULL,
	`round_id` text NOT NULL,
	`question_id` text NOT NULL,
	`answer_a` text NOT NULL,
	`answer_b` text NOT NULL,
	`revealed_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `round_id`)
);
--> statement-breakpoint
CREATE INDEX `pair_results_room_idx` ON `pair_results` (`room_id`,`revealed_at`);--> statement-breakpoint
CREATE TABLE `pair_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pair_rooms_expiry_idx` ON `pair_rooms` (`expires_at`);