import fs from "node:fs/promises";

const DATA_URL =
  process.env.LCD_DATA_URL ||
  "https://api-lcd.vercel.app/levels";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const SNAPSHOT_FILE = "state/lcd-snapshot.json";
const SNAPSHOT_VERSION = 2;

if (!WEBHOOK_URL) {
  throw new Error(
    "DISCORD_WEBHOOK_URL is missing. Add it as a GitHub Actions repository secret."
  );
}

function getTier(rank) {
  if (rank <= 15) return "Main";
  if (rank <= 30) return "Extended";
  return "Forgotten";
}

function asText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asArray(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((value) => asText(value))
    .filter(Boolean);
}

function normalize(item) {
  const rank = Number(item.rank);

  const recordId = item.id ?? null;
  const levelId = item.level_id ?? null;

  return {
    // level_id remains the primary identity so this is compatible
    // with the original version of the logger.
    key: asText(levelId ?? recordId),

    id: recordId,
    level_id: levelId,

    title: asText(
      item.title,
      "Unknown Level"
    ),

    creator: asText(
      item.creator,
      "Unknown Creator"
    ),

    difficulty: asText(
      item.difficulty,
      "Unknown"
    ),

    description: asText(
      item.description
    ),

    image_url: asText(
      item.image_url
    ),

    youtube_urls: asArray(
      item.youtube_urls
    ),

    beaten_by: asArray(
      item.beaten_by
    ),

    rank:
      Number.isInteger(rank) &&
      rank >= 1
        ? rank
        : null,
  };
}

function assertValidLevels(levels) {
  if (
    !Array.isArray(levels) ||
    levels.length === 0
  ) {
    throw new Error(
      "LCD API returned no usable levels. Refusing to overwrite the saved snapshot."
    );
  }

  const keys = new Set();
  const ranks = new Set();

  for (const level of levels) {
    if (!level.key) {
      throw new Error(
        "A level is missing both a stable Base44 id and level_id."
      );
    }

    if (keys.has(level.key)) {
      throw new Error(
        `Duplicate level key detected: ${level.key}`
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
        `Duplicate rank detected in API data: #${level.rank}`
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
          "LLL-LCD-Change-Logger/2.0",

        Accept:
          "application/json",
      },

      signal:
        AbortSignal.timeout(
          20_000
        ),
    }
  );

  if (!response.ok) {
    throw new Error(
      `LCD API returned ${response.status} ${response.statusText}`
    );
  }

  const json =
    await response.json();

  if (
    json &&
    typeof json === "object" &&
    json.ok === false
  ) {
    throw new Error(
      "LCD API returned ok=false."
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
      "Could not find a level array in the LCD API response."
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

    /*
      Old versions of the logger
      saved a raw array.

      Instead of reporting every
      level as changed after the
      upgrade, silently create a
      fresh v2 baseline.
    */
    if (Array.isArray(parsed)) {
      console.log(
        "Legacy snapshot detected. A fresh v2 baseline will be created."
      );

      return null;
    }

    if (
      parsed?.version !==
        SNAPSHOT_VERSION ||
      !Array.isArray(
        parsed?.levels
      )
    ) {
      console.log(
        "Unknown snapshot format. A fresh baseline will be created."
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
    tierChanges: [],
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

    /*
      Rank change
    */
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

      const oldTier =
        getTier(
          previous.rank
        );

      const newTier =
        getTier(
          current.rank
        );

      if (
        oldTier !==
        newTier
      ) {
        changes.tierChanges.push({
          key:
            current.key,

          level:
            current,

          from:
            oldTier,

          to:
            newTier,

          oldRank:
            previous.rank,

          newRank:
            current.rank,
        });
      }
    }

    /*
      Normal information edits
    */
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

    /*
      Array fields
    */
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

  /*
    Deleted / disappeared levels
  */
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
      3750,

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

  /*
    Added
  */
  if (
    changes.added.length
  ) {
    pushLimited(
      lines,
      "### 🆕 Levels Added",
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
          )} (${getTier(
            level.rank
          )})`,

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

  /*
    Removed
  */
  if (
    changes.removed.length
  ) {
    pushLimited(
      lines,
      "### 🗑️ Levels Removed From This Feed",
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

  /*
    Tier changes
  */
  if (
    changes.tierChanges.length
  ) {
    pushLimited(
      lines,
      "### 🔀 Tier Changes",
      state
    );

    for (
      const change
      of changes.tierChanges
    ) {
      if (
        !pushLimited(
          lines,

          `• **${inline(
            change.level.title,
            80
          )}** — #${change.oldRank} ${change.from} → #${change.newRank} ${change.to}`,

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

  /*
    Avoid printing the exact same
    movement twice if it already
    appeared under Tier Changes.
  */
  const tierKeys =
    new Set(
      changes.tierChanges
        .map(
          (change) =>
            change.key
        )
    );

  const normalRankChanges =
    changes.rankChanges
      .filter(
        (change) =>
          !tierKeys.has(
            change.key
          )
      );

  /*
    Rank changes
  */
  if (
    normalRankChanges.length
  ) {
    pushLimited(
      lines,
      "### 📊 Rank Changes",
      state
    );

    for (
      const change
      of normalRankChanges
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

  /*
    Metadata edits
  */
  if (
    changes.edits.length
  ) {
    pushLimited(
      lines,
      "### ✏️ Level Information Updated",
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

  /*
    Discord embed size safety
  */
  if (
    state.truncated
  ) {
    const suffix =
      "\n\n*More changes existed, but this Discord message was shortened to stay within Discord's embed limit.*";

    let output =
      lines.join("\n");

    output =
      output.slice(
        0,
        Math.max(
          0,
          3900 -
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
            /*
              IMPORTANT:

              We intentionally DO NOT
              set "username".

              Discord will use your
              webhook's configured
              name and avatar.

              Yours is named:
              LLL
            */

            allowed_mentions: {
              parse: [],
            },

            embeds: [
              {
                title:
                  "LCD Community List Update",

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
            20_000
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

    levels,
  };

  await fs.writeFile(
    SNAPSHOT_FILE,

    `${JSON.stringify(
      snapshot,
      null,
      2
    )}\n`,

    "utf8"
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
  First run / upgraded legacy snapshot
*/
if (!previous) {
  console.log(
    `Creating initial baseline with ${current.length} levels.`
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
    `No LCD changes detected across ${current.length} levels.`
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

  Send Discord BEFORE updating
  the snapshot.

  If Discord fails, the snapshot
  remains unchanged.

  That means the change will be
  retried on the next run instead
  of being lost.
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
  "Discord log sent successfully and snapshot updated."
);
