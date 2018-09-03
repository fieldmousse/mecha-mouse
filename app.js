"use strict";

const Sequelize = require("sequelize"),
    path = require("path"),
    assert = require("assert"),
    dotenv = require("dotenv"),
    Discord = require('discord.js'),
    natural = require("natural"),
    fs = require("fs"),
    moment = require("moment"),
    wordnet = new natural.WordNet(),
    tokenizer = new natural.TreebankWordTokenizer(),
    COMMON_CORPUS = fs.readFileSync(path.join(__dirname, "./common_corpus.csv"), { encoding: "utf8" }).split("\n").filter(Boolean),
    COMMON_CORPUS_HASH = new Set(COMMON_CORPUS),
    REALLY_COMMON_WORDS = COMMON_CORPUS.slice(0, 100),
    Op = Sequelize.Op,
    spellcheck = new natural.Spellcheck(COMMON_CORPUS);

const client = new Discord.Client();

dotenv.config();
const { DISCORD_SECRET } = process.env;
assert(typeof DISCORD_SECRET !== "undefined", "DISCORD_SECRET required in env");

const db = new Sequelize("app", null, null, {
    host: "localhost",
    dialect: "sqlite",
    storage: path.join(__dirname, "data"),
    sync: { force: false },
    logging: false,
});

const User = db.define("User", {
    id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,
    },
    discordId: {
        type: Sequelize.BIGINT,
    },
});

const Lexicon = db.define("Lexicon", {
    uid: {
        type: Sequelize.BIGINT,
        primaryKey: true,
    },
    root: {
        type: Sequelize.STRING,
        primaryKey: true,
    },
    uses: {
        type: Sequelize.INTEGER,
        defaultValue: 1,
    },
    validated: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
    },
});

const CommonWord = db.define("CommonWord", {
    root: {
        type: Sequelize.STRING,
        primaryKey: true,
    },
});

CommonWord.destroy({ where: {} }).then(() => {
    CommonWord.bulkCreate(REALLY_COMMON_WORDS.map(root => ({ root })), {});
});

User.hasMany(Lexicon, { foreignKey: "uid", sourceKey: "id" });

function formDefinition(word, wordnetResults) {
    const definitions = wordnetResults.map(({ lemma, def, gloss, synonyms }) => (
        `${lemma}: ${def}. ${gloss}` + "\n" +
        `synonyms: ${synonyms}`
    ));
    return word + ": \n" + definitions.join("\n\n");
}

/**
 * Lookup a user's stats for a word
 * @param user The Sequelzie model for the user
 * @param {string} root to lookup
 * @returns {Promise<{}>} the stats
 */
async function wordStats({ id: uid }, root) {
    const lex = await Lexicon.findOne({
        where: { uid, root },
        attributes: ["uses", "validated", "createdAt", "updatedAt"],
    });
    const others = await Lexicon.count({
        where: {
            uid: {
                [Op.not]: uid,
            },
            root,
        },
    });
    if (!lex) {
        return {
            known: false,
            others,
        };
    }
    const { validated, uses, created, updated } = lex;
    return {
        known: true, validated, uses, created, updated, others: others || 0,
    };
}

async function formattedWordStats(user, root) {
    const { known, validated, uses, created, updated, others } = await wordStats(user, root);
    let text = "";
    if (!known) {
        text += `I don't have any record of you using "${root}". `;
    }
    if (known) {
        if (!validated) {
            text += `I don't know what ${root} means. `;
        }
        const createdMoment = moment(created);
        const updatedMoment = moment(updated);
        text += `You have used the word "${root}" ${uses} times. You first used the word ${createdMoment.fromNow()}. You last used "${root}" ${updatedMoment.fromNow()}. `;
    }
    text += `${others} other user${others !== 1 ? "s" : ""} know${others !== 1 ? "" : "s"} this word. `;
    return text;
}

function lookupWordnet(word) {
    return new Promise(resolve => {
        wordnet.lookup(word, results => {
            if (results.length !== 0) {
                return resolve([results, word]);
            }
            const [correction] = spellcheck.getCorrections(word, 1);
            if (correction) {
                return wordnet.lookup(word, results => resolve([results, correction]));
            }
            resolve([[], word]);
        });
    });
}

function createUser(discordId, transaction) {
    return User.findOrCreate({
        where: { discordId },
        defaults: { discordId },
        transaction,
    });
}

async function verifyWord(word) {
    const valid = COMMON_CORPUS_HASH.has(word);
    if (valid) return [true, word];
    const [wn, correction] = await lookupWordnet(word);
    if (wn.length > 0) return [true, correction];
    return [false, word];
}

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

const lookupCmd = /^!lookup\s+(.*)$/;
const wordsCmd = /^!words$/;
const statsCmd = /^!word\s+(.*)$/;

client.on('message', async msg => {
    const transaction = await db.transaction({ autocommit: false });
    const content = msg.content.toLowerCase();
    try {
        const [user] = await createUser(msg.author.id, transaction);
        const uid = user.id;

        const lookupMatch = lookupCmd.exec(content);

        if (lookupMatch !== null) {
            const word = lookupMatch[1];
            const [result] = await lookupWordnet(word);
            const definition = "\n" + formDefinition(word, result);
            msg.reply(definition.length < 2000 ? definition : "Results are too long to post :(");
            return;
        }

        const wordsMatch = wordsCmd.exec(content);

        if (wordsMatch !== null) {
            const query = `SELECT root, uses
                           FROM Lexicons 
                           WHERE validated 
                           AND uid = ? 
                           AND root NOT IN (SELECT root FROM CommonWords)
                           ORDER BY uses DESC LIMIT 10;`
            const [words] = await db.query(query, { replacements: [user.id], transaction });
            const count = await Lexicon.count({ where: { uid } });
            msg.reply(`\nYou have a total of \`${count}\` different words stored\nHere are your top ten words: \n` + words.map(({ root, uses }) => `${root} - ${uses}`).join("\n"));
            return;
        }

        const statMatch = statsCmd.exec(content);

        if (statMatch !== null) {
            msg.reply(await formattedWordStats(user, statMatch[1]));
        }

        const tokens = tokenizer.tokenize(content.replace(".", " "));
        for (const token of tokens) {
            const [changed] = await Lexicon.update(
                {
                    uses: db.literal("uses + 1"),
                },
                {
                    where: { uid, root: token },
                    transaction,
                },
            );
            if (changed === 0) {
                const [validated, root] = await verifyWord(token);
                await Lexicon.create({
                    uid, uses: 1, validated, root,
                }, { transaction });
            }
        }
    } finally {
        await transaction.commit();
        console.log(`${msg.author.tag}: ${msg.content}`);
    }
});

client.login(DISCORD_SECRET);
