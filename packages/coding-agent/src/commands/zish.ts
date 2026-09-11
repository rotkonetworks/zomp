/**
 * `zish` — inspect and steer the zish workers running on this machine.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { zishHelp as commandHelp } from "../cli/command-help";
import { runZishCommand, type ZishAction } from "../cli/zish-cli";

const ACTIONS: ZishAction[] = ["list", "tail", "answer", "kill", "spawn"];

export default class Zish extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), tail, answer, kill, or spawn",
			required: false,
			options: ACTIONS,
		}),
		host: Args.string({ description: "pid of the hosting zish process (tail/answer/kill)", required: false }),
		id: Args.string({ description: "session id (tail/answer/kill)", required: false }),
		text: Args.string({
			description: "Answer text for `answer` — pass it as one quoted argument",
			required: false,
		}),
	};

	static flags = {
		command: Flags.string({ description: "Shell line to type into a spawned worker (spawn)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON (list)" }),
		follow: Flags.boolean({ char: "f", description: "Keep streaming new transcript events (tail)" }),
		from: Flags.integer({ description: "Byte offset to start reading the transcript from (tail)" }),
		timeout: Flags.integer({ description: "Seconds to wait for a spawned worker's session (spawn)" }),
	};

	static examples = [
		"omp zish",
		"omp zish list --json",
		"omp zish spawn --command probe",
		"omp zish tail 12345 1 --follow",
		'omp zish answer 12345 1 "yes, proceed"',
		"omp zish kill 12345 1",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Zish);
		const parseId = (value: string | undefined): number | undefined => {
			if (value === undefined) return undefined;
			const parsed = Number.parseInt(value, 10);
			if (Number.isNaN(parsed)) throw new Error(`zish: not a number: ${value}`);
			return parsed;
		};
		await runZishCommand({
			action: (args.action ?? "list") as ZishAction,
			host: parseId(args.host),
			id: parseId(args.id),
			text: args.text,
			command: flags.command,
			json: flags.json ?? false,
			follow: flags.follow ?? false,
			from: flags.from ?? 0,
			timeout: flags.timeout ?? 30,
		});
	}
}
