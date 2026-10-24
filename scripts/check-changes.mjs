import fs from "node:fs/promises";

const DATA_URL =
  process.env.LCD_DATA_URL ||
  "https://api-lcd.vercel.app/api/extended";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Keep this filename compatible with the workflow you already use.
const SNAPSHOT_FILE = "state/lcd-snapshot.json";
const SNAPSHOT_VERSION = 3;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_EMBED_DESCRIPTION = 3900;
const BUILD_LIMIT = 3750;

if (!WEBHOOK_URL) {
  throw new Error(
    "DISCORD_WEBHOOK_URL is missing. Add it as a GitHub Actions repository secret."
  );
}

function asText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asArray(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => asText(item).trim())
    .filter(Boolean);
}

function normalize(item) {
  const rank = Number(item?.rank);
  const recordId = item?.id ?? null;
  const levelId = item?.level_id ?? null;

  return {
    // Base44 record id is the most stable identity for this NEW Extended
    // logger. If level_id is corrected later, it will be reported as an edit
    // instead of looking like one level was removed and another was added.
    key: asText(recordId ?? levelId),

    id: recordId,
    level_id: levelId,

    title: asText(item?.title, "Unknown Level"),
    creator: asText(item?.creator, "Unknown Creator"),
    difficulty: asText(item?.difficulty, "Unknown"),
    description: asText(item?.description),
    image_url: asText(item?.image_url),
    youtube_urls: asArray(item?.youtube_urls),
    beaten_by: asArray(item?.beaten_by),

    rank:
      Number.isInteger(rank) &&
      rank >= 1
        ? rank
        : null,
  };
}

function assertValidLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error(
      "Extended API returned no usable levels. Refusing to overwrite the saved snapshot."
    );
  }

  const keys = new Set();
  const ranks = new Set();

  for (const level of levels) {
    if (!level.key) {
      throw new Error(
        "An Extended level is missing both level_id and a stable Base44 id."
      );
    }

    if (keys.has(level.key)) {
      throw new Error(
        `Duplicate Extended level key detected: ${level.key}`
      );
    }

    keys.add(level.key);

    if (level.rank === null) {
      throw new Error(
        `Invalid rank detected for ${level.title}.`
      );
    }

    if (ranks.has(level.rank)) {
      throw new Error(
        `Duplicate Extended rank detected: #${level.rank}`
      );
    }

    ranks.add(level.rank);
  }
}

async function loadCurrentData() {
  const response = await fetch(
    DATA_URL,
    {
      headers: {
        "User-Agent":
          "LLL-LCD-Extended-Change-Logger/1.0",

        Accept:
          "application/json",
      },

      signal:
        AbortSignal.timeout(
          REQUEST_TIMEOUT_MS
        ),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Extended API returned ${response.status} ${response.statusText}`
    );
  }

  const json =
    await response.json();

  if (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    json.ok === false
  ) {
    throw new Error(
      "Extended API returned ok=false."
    );
  }

  const rawItems =
    Array.isArray(json)
      ? json
      : Array.isArray(
            json?.items
        )
        ? json.items
        : null;

  if (!rawItems) {
    throw new Error(
      "Could not find an Extended level array in the API response."
    );
  }

  const levels =
    rawItems
      .map(normalize)

      .filter(
        (item) =>
          item.key &&
          item.rank !== null
      )

      .sort(
        (a, b) =>
          a.rank - b.rank
      );

  assertValidLevels(levels);

  return levels;
}

async function loadPreviousData() {
  try {
    const raw =
      await fs.readFile(
        SNAPSHOT_FILE,
        "utf8"
      );

    const parsed =
      JSON.parse(raw);

    // Older versions of the logger stored a raw array.
    // Create a fresh baseline instead of posting a giant false changelog.
    if (Array.isArray(parsed)) {
      console.log(
        "Legacy snapshot detected. A fresh Extended baseline will be created."
      );

      return null;
    }

    // Protect against accidentally copying a Main-list snapshot
    // into this separate Extended logger repository.
    if (
      parsed?.version !== SNAPSHOT_VERSION ||
      parsed?.list !== "Extended" ||
      parsed?.source !== DATA_URL ||
      !Array.isArray(
        parsed?.levels
      )
    ) {
      console.log(
        "Snapshot does not belong to this Extended feed. A fresh baseline will be created."
      );

      return null;
    }

    if (
      parsed.levels.length === 0
    ) {
      return null;
    }

    return parsed.levels;
  } catch (error) {
    if (
      error?.code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

function sameArray(a, b) {
  return (
    JSON.stringify(a ?? []) ===
    JSON.stringify(b ?? [])
  );
}

function compare(
  oldLevels,
  newLevels
) {
  const oldMap =
    new Map(
      oldLevels.map(
        (level) => [
          level.key,
          level,
        ]
      )
    );

  const newMap =
    new Map(
      newLevels.map(
        (level) => [
          level.key,
          level,
        ]
      )
    );

  const changes = {
    added: [],
    removed: [],
    rankChanges: [],
    edits: [],
  };

  for (
    const current
    of newLevels
  ) {
    const previous =
      oldMap.get(
        current.key
      );

    if (!previous) {
      changes.added.push(
        current
      );

      continue;
    }

    if (
      previous.rank !==
      current.rank
    ) {
      changes.rankChanges.push({
        key:
          current.key,

        level:
          current,

        from:
          previous.rank,

        to:
          current.rank,
      });
    }

    const fieldChanges = [];

    const scalarFields = [
      [
        "level_id",
        "Level ID",
      ],

      [
        "title",
        "Title",
      ],

      [
        "creator",
        "Creator",
      ],

      [
        "difficulty",
        "Difficulty",
      ],

      [
        "description",
        "Description",
      ],

      [
        "image_url",
        "Image URL",
      ],
    ];

    for (
      const [
        field,
        label,
      ]
      of scalarFields
    ) {
      if (
        previous[field] !==
        current[field]
      ) {
        fieldChanges.push({
          field,
          label,

          oldValue:
            previous[field],

          newValue:
            current[field],
        });
      }
    }

    const arrayFields = [
      [
        "youtube_urls",
        "Video URLs",
      ],

      [
        "beaten_by",
        "Beaten By",
      ],
    ];

    for (
      const [
        field,
        label,
      ]
      of arrayFields
    ) {
      if (
        !sameArray(
          previous[field],
          current[field]
        )
      ) {
        fieldChanges.push({
          field,
          label,

          oldValue:
            previous[field] ??
            [],

          newValue:
            current[field] ??
            [],
        });
      }
    }

    if (
      fieldChanges.length > 0
    ) {
      changes.edits.push({
        level:
          current,

        fields:
          fieldChanges,
      });
    }
  }

  for (
    const previous
    of oldLevels
  ) {
    if (
      !newMap.has(
        previous.key
      )
    ) {
      changes.removed.push(
        previous
      );
    }
  }

  return changes;
}

function hasChanges(changes) {
  return Object
    .values(changes)
    .some(
      (list) =>
        list.length > 0
    );
}

function inline(
  value,
  max = 120
) {
  let text;

  if (
    Array.isArray(value)
  ) {
    text =
      value.length
        ? value.join(", ")
        : "(none)";
  } else if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    text = "(empty)";
  } else {
    text =
      String(value);
  }

  text =
    text
      .replace(
        /`/g,
        "'"
      )

      .replace(
        /\s+/g,
        " "
      )

      .trim();

  if (
    text.length >
    max
  ) {
    text =
      `${text.slice(
        0,
        max - 1
      )}…`;
  }

  return text;
}

function pushLimited(
  lines,
  value,
  state
) {
  const candidate =
    [
      ...lines,
      value,
    ].join("\n");

  if (
    candidate.length <=
    state.maxLength
  ) {
    lines.push(value);

    return true;
  }

  state.truncated =
    true;

  return false;
}

function makeMessage(
  changes
) {
  const lines = [];

  const state = {
    maxLength:
      BUILD_LIMIT,

    truncated:
      false,
  };

  const summary = [
    `${changes.added.length} added`,
    `${changes.removed.length} removed`,
    `${changes.rankChanges.length} rank changes`,
    `${changes.edits.length} info edits`,
  ].join(" • ");

  pushLimited(
    lines,
    `**Summary:** ${summary}`,
    state
  );

  pushLimited(
    lines,
    "",
    state
  );

  if (
    changes.added.length
  ) {
    pushLimited(
      lines,
      "### 🆕 Extended Levels Added",
      state
    );

    for (
      const level
      of changes.added
    ) {
      if (
        !pushLimited(
          lines,

          `• **#${level.rank} ${inline(
            level.title,
            80
          )}** — ${inline(
            level.creator,
            60
          )} (Extended)`,

          state
        )
      ) {
        break;
      }
    }

    pushLimited(
      lines,
      "",
      state
    );
  }

  if (
    changes.removed.length
  ) {
    pushLimited(
      lines,
      "### 🗑️ Extended Levels Removed",
      state
    );

    for (
      const level
      of changes.removed
    ) {
      if (
        !pushLimited(
          lines,

          `• **#${level.rank} ${inline(
            level.title,
            80
          )}** — ${inline(
            level.creator,
            60
          )}`,

          state
        )
      ) {
        break;
      }
    }

    pushLimited(
      lines,
      "",
      state
    );
  }

  if (
    changes.rankChanges.length
  ) {
    pushLimited(
      lines,
      "### 📊 Extended Rank Changes",
      state
    );

    for (
      const change
      of changes.rankChanges
    ) {
      const direction =
        change.to <
        change.from
          ? "⬆️"
          : "⬇️";

      if (
        !pushLimited(
          lines,

          `• ${direction} **${inline(
            change.level.title,
            80
          )}**: #${change.from} → #${change.to}`,

          state
        )
      ) {
        break;
      }
    }

    pushLimited(
      lines,
      "",
      state
    );
  }

  if (
    changes.edits.length
  ) {
    pushLimited(
      lines,
      "### ✏️ Extended Level Information Updated",
      state
    );

    for (
      const edit
      of changes.edits
    ) {
      if (
        !pushLimited(
          lines,

          `**${inline(
            edit.level.title,
            80
          )}**`,

          state
        )
      ) {
        break;
      }

      for (
        const field
        of edit.fields
      ) {
        const line =
          `• ${field.label}: \`${inline(
            field.oldValue
          )}\` → \`${inline(
            field.newValue
          )}\``;

        if (
          !pushLimited(
            lines,
            line,
            state
          )
        ) {
          break;
        }
      }

      if (
        state.truncated
      ) {
        break;
      }
    }
  }

  if (
    state.truncated
  ) {
    const suffix =
      "\n\n*More changes existed, but this Discord message was shortened to stay within Discord's embed limit.*";

    const output =
      lines
        .join("\n")
        .slice(
          0,
          Math.max(
            0,
            MAX_EMBED_DESCRIPTION -
              suffix.length
          )
        );

    return (
      output +
      suffix
    );
  }

  return lines
    .join("\n")
    .trim();
}

async function sendDiscord(
  message
) {
  const response =
    await fetch(
      WEBHOOK_URL,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            // Do NOT override username/avatar.
            // Discord will use the webhook's configured identity,
            // such as "LLL Extended".
            allowed_mentions: {
              parse: [],
            },

            embeds: [
              {
                title:
                  "LCD Extended List Update",

                description:
                  message,

                timestamp:
                  new Date()
                    .toISOString(),
              },
            ],
          }),

        signal:
          AbortSignal.timeout(
            REQUEST_TIMEOUT_MS
          ),
      }
    );

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Discord webhook failed: ${response.status} ${body}`.trim()
    );
  }
}

async function saveSnapshot(
  levels
) {
  await fs.mkdir(
    "state",
    {
      recursive: true,
    }
  );

  const snapshot = {
    version:
      SNAPSHOT_VERSION,

    generated_at:
      new Date()
        .toISOString(),

    source:
      DATA_URL,

    list:
      "Extended",

    levels,
  };

  const serialized =
    `${JSON.stringify(
      snapshot,
      null,
      2
    )}\n`;

  const temporaryFile =
    `${SNAPSHOT_FILE}.tmp`;

  // Write safely to a temporary file first,
  // then replace the actual snapshot.
  await fs.writeFile(
    temporaryFile,
    serialized,
    "utf8"
  );

  await fs.rename(
    temporaryFile,
    SNAPSHOT_FILE
  );
}

/*
==================================================
MAIN PROGRAM
==================================================
*/

const current =
  await loadCurrentData();

const previous =
  await loadPreviousData();

/*
First run / fresh baseline
*/
if (!previous) {
  console.log(
    `Creating initial Extended baseline with ${current.length} levels.`
  );

  console.log(
    "No Discord message is sent on the first run."
  );

  await saveSnapshot(
    current
  );

  process.exit(0);
}

/*
Compare
*/
const changes =
  compare(
    previous,
    current
  );

if (
  !hasChanges(changes)
) {
  console.log(
    `No Extended List changes detected across ${current.length} levels.`
  );

  process.exit(0);
}

/*
Build Discord message
*/
const message =
  makeMessage(
    changes
  );

console.log(message);

/*
IMPORTANT:

Send Discord BEFORE updating the snapshot.

If Discord fails, the old snapshot remains unchanged.
That means the same change gets retried on the next run.
*/
await sendDiscord(
  message
);

/*
Discord accepted the message,
so now save the new state.
*/
await saveSnapshot(
  current
);

console.log(
  "Extended Discord log sent successfully and snapshot updated."
);
