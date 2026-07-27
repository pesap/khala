// Protoss names from StarCraft lore. Each Executor session draws one at random.
const NAME_RADIX = 36;

const PROTOSS_NAMES = [
	"Adun",
	"Alarak",
	"Artanis",
	"Fenix",
	"Karass",
	"Mohandar",
	"Raszagal",
	"Rohana",
	"Selendis",
	"Talandar",
	"Tassadar",
	"Ulrezaj",
	"Urun",
	"Vorazun",
	"Zeratul",
] as const;

type ProtossName = (typeof PROTOSS_NAMES)[number];

function randomProtossName(used: ReadonlySet<string>): ProtossName {
	const available = PROTOSS_NAMES.filter((name) => !used.has(name));
	if (available.length === 0) {
		// All names are in use; append a suffix to avoid collisions.
		const index = Math.floor(Math.random() * PROTOSS_NAMES.length);
		const name = PROTOSS_NAMES[index] ?? PROTOSS_NAMES[0];
		return `${name}-${Date.now().toString(NAME_RADIX)}` as ProtossName;
	}
	return available[Math.floor(Math.random() * available.length)] as ProtossName;
}

export { randomProtossName };
