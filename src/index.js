const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} = require('discord.js');

try {
  require('dotenv').config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.resolve(ROOT_DIR, process.env.CONFIG_PATH || 'config.json');
const DATA_PATH = path.join(ROOT_DIR, 'data', 'blacklist.json');
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const DEFAULT_CONFIG = {
  discordToken: '',
  discordGuildId: '',
  adminRoleIds: [],
  adminUserIds: [],
  blacklistRoleId: '',
  logChannelId: '',
  dmBlacklistedUsers: false,
  removeBlacklistRoleOnUnblacklist: true,
  embed: {
    title: 'BLACKLIST - JOINED WITH ROLE',
    color: '#e30000',
    authorName: 'ECLIPSE | FiveM - Bot',
    authorIconUrl: '',
    thumbnailUrl: '',
    imageUrl: '',
    footerText: 'Eclipse Military | FiveM',
    footerIconUrl: ''
  }
};

function logInfo(message) {
  console.log(`[INFO] ${message}`);
}

function logWarn(message) {
  console.warn(`[WARN] ${message}`);
}

function logError(message, error) {
  console.error(`[ERROR] ${message}`);
  if (error) {
    console.error(error);
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    throw new Error(`Failed to read JSON from ${filePath}: ${error.message}`);
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  fs.writeFileSync(tempPath, payload, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(tempPath, filePath);
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];
}

function cleanConfigValue(value) {
  const text = String(value || '').trim();
  if (!text || /^your_.+_here$/i.test(text)) {
    return '';
  }

  return text;
}

function loadConfig() {
  const rawConfig = readJsonFile(CONFIG_PATH, {});
  const config = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    embed: {
      ...DEFAULT_CONFIG.embed,
      ...(rawConfig.embed || {})
    }
  };

  config.adminRoleIds = normalizeStringArray(config.adminRoleIds);
  config.adminUserIds = normalizeStringArray(config.adminUserIds);
  config.discordToken = cleanConfigValue(process.env.DISCORD_TOKEN) || cleanConfigValue(config.discordToken);
  config.discordGuildId = cleanConfigValue(process.env.DISCORD_GUILD_ID) || cleanConfigValue(config.discordGuildId);
  config.blacklistRoleId = String(config.blacklistRoleId || '').trim();
  config.logChannelId = String(config.logChannelId || '').trim();
  config.dmBlacklistedUsers = Boolean(config.dmBlacklistedUsers);
  config.removeBlacklistRoleOnUnblacklist = config.removeBlacklistRoleOnUnblacklist !== false;

  return config;
}

const config = loadConfig();

function isSnowflake(value) {
  return SNOWFLAKE_PATTERN.test(String(value || '').trim());
}

function normalizeUserId(value) {
  const cleaned = String(value || '').replace(/[<@!>]/g, '').trim();
  return isSnowflake(cleaned) ? cleaned : '';
}

function validateUrl(value, fieldName, errors) {
  if (!value) {
    return;
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      errors.push(`${fieldName} must be an HTTP or HTTPS URL.`);
    }
  } catch {
    errors.push(`${fieldName} must be a valid URL.`);
  }
}

function validateStaticConfig() {
  const errors = [];

  if (!config.discordToken) {
    errors.push('DISCORD_TOKEN or config.discordToken is required.');
  }

  if (config.discordGuildId && !isSnowflake(config.discordGuildId)) {
    errors.push('discordGuildId must be a valid Discord ID.');
  }

  if (!isSnowflake(config.blacklistRoleId)) {
    errors.push('blacklistRoleId must be a valid Discord role ID.');
  }

  if (!isSnowflake(config.logChannelId)) {
    errors.push('logChannelId must be a valid Discord channel ID.');
  }

  for (const roleId of config.adminRoleIds) {
    if (!isSnowflake(roleId)) {
      errors.push(`adminRoleIds contains an invalid Discord role ID: ${roleId}`);
    }
  }

  for (const userId of config.adminUserIds) {
    if (!isSnowflake(userId)) {
      errors.push(`adminUserIds contains an invalid Discord user ID: ${userId}`);
    }
  }

  validateUrl(config.embed.authorIconUrl, 'embed.authorIconUrl', errors);
  validateUrl(config.embed.thumbnailUrl, 'embed.thumbnailUrl', errors);
  validateUrl(config.embed.imageUrl, 'embed.imageUrl', errors);
  validateUrl(config.embed.footerIconUrl, 'embed.footerIconUrl', errors);

  if (errors.length) {
    throw new Error(`Configuration is invalid:\n- ${errors.join('\n- ')}`);
  }
}

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  if (!fs.existsSync(DATA_PATH)) {
    atomicWriteJson(DATA_PATH, []);
  }
}

function sanitizeEntry(entry) {
  const userId = normalizeUserId(entry.userId);
  if (!userId) {
    return null;
  }

  const blacklistedAt = Number.isNaN(Date.parse(entry.blacklistedAt))
    ? new Date().toISOString()
    : entry.blacklistedAt;
  const updatedAt = Number.isNaN(Date.parse(entry.updatedAt))
    ? blacklistedAt
    : entry.updatedAt;

  return {
    userId,
    tag: String(entry.tag || `User ${userId}`).slice(0, 128),
    reason: String(entry.reason || 'No reason provided.').slice(0, 1000),
    blacklistedById: normalizeUserId(entry.blacklistedById) || 'unknown',
    blacklistedByTag: String(entry.blacklistedByTag || 'Unknown admin').slice(0, 128),
    blacklistedAt,
    updatedAt
  };
}

function readBlacklist() {
  ensureDataFile();
  const rawEntries = readJsonFile(DATA_PATH, []);
  if (!Array.isArray(rawEntries)) {
    throw new Error(`${DATA_PATH} must contain a JSON array.`);
  }

  const entriesByUser = new Map();
  for (const rawEntry of rawEntries) {
    const entry = sanitizeEntry(rawEntry || {});
    if (entry) {
      entriesByUser.set(entry.userId, entry);
    }
  }

  return [...entriesByUser.values()];
}

function writeBlacklist(entries) {
  const sanitized = entries.map(sanitizeEntry).filter(Boolean);
  atomicWriteJson(DATA_PATH, sanitized);
}

function findBlacklistEntry(userId) {
  const id = normalizeUserId(userId);
  return readBlacklist().find((entry) => entry.userId === id) || null;
}

function upsertBlacklistEntry({ userId, tag, reason, admin }) {
  const id = normalizeUserId(userId);
  if (!id) {
    throw new Error('Invalid Discord user ID.');
  }

  const entries = readBlacklist();
  const now = new Date().toISOString();
  const existingIndex = entries.findIndex((entry) => entry.userId === id);
  const previous = existingIndex >= 0 ? entries[existingIndex] : null;
  const entry = {
    userId: id,
    tag: tag || previous?.tag || `User ${id}`,
    reason: reason || 'No reason provided.',
    blacklistedById: admin.id,
    blacklistedByTag: admin.tag,
    blacklistedAt: previous?.blacklistedAt || now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    entries[existingIndex] = entry;
  } else {
    entries.push(entry);
  }

  writeBlacklist(entries);
  return { entry, updated: Boolean(previous) };
}

function removeBlacklistEntry(userId) {
  const id = normalizeUserId(userId);
  const entries = readBlacklist();
  const entry = entries.find((item) => item.userId === id) || null;

  if (!entry) {
    return null;
  }

  writeBlacklist(entries.filter((item) => item.userId !== id));
  return entry;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Prague'
  }).format(new Date(value));
}

function truncate(value, maxLength = 180) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function buildLogEmbed(entry, action, adminTag) {
  const adminValue = normalizeUserId(entry.blacklistedById)
    ? `<@${entry.blacklistedById}>`
    : entry.blacklistedByTag || adminTag || 'Unknown admin';

  const embed = new EmbedBuilder()
    .setColor(config.embed.color)
    .setTitle(config.embed.title)
    .setDescription(action)
    .addFields(
      { name: 'User', value: `<@${entry.userId}>`, inline: false },
      { name: 'Blacklist Reason', value: entry.reason || 'No reason provided.', inline: false },
      { name: 'Blacklisted By', value: adminValue, inline: true },
      { name: 'Blacklist Date', value: formatDate(entry.blacklistedAt), inline: true }
    )
    .setTimestamp();

  if (config.embed.authorName) {
    embed.setAuthor({
      name: config.embed.authorName,
      iconURL: config.embed.authorIconUrl || undefined
    });
  }

  if (config.embed.thumbnailUrl) {
    embed.setThumbnail(config.embed.thumbnailUrl);
  }

  if (config.embed.imageUrl) {
    embed.setImage(config.embed.imageUrl);
  }

  if (config.embed.footerText) {
    embed.setFooter({
      text: config.embed.footerText,
      iconURL: config.embed.footerIconUrl || undefined
    });
  }

  return embed;
}

function buildTargetSelectionComponents(action) {
  const labels = {
    add: 'Choose a server user to blacklist',
    remove: 'Choose a server user to remove',
    check: 'Choose a server user to check'
  };

  const userSelectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`blacklist:user:${action}`)
      .setPlaceholder(labels[action] || 'Choose a server user')
      .setMinValues(1)
      .setMaxValues(1)
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`blacklist:id:${action}`)
      .setLabel('Use User ID')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('blacklist:back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
  );

  return [userSelectRow, buttonRow];
}

function buildTargetSelectionEmbed(action) {
  const titles = {
    add: 'Select User To Blacklist',
    remove: 'Select User To Remove',
    check: 'Select User To Check'
  };

  const descriptions = {
    add: 'Search for a server member below. Use the ID button for users who are not currently in the server.',
    remove: 'Search for a server member below, or use the ID button if they are no longer in the server.',
    check: 'Search for a server member below, or use the ID button for an outside user.'
  };

  return buildSimpleEmbed(titles[action] || 'Select User', descriptions[action] || 'Choose a user.');
}

function buildSimpleEmbed(title, description, color = 0x2f80ed) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function buildMenuComponents() {
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('blacklist:add')
      .setLabel('Add / Update')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('blacklist:remove')
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('blacklist:check')
      .setLabel('Check')
      .setStyle(ButtonStyle.Secondary)
  );

  const utilityRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('blacklist:list')
      .setLabel('List Entries')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('blacklist:stats')
      .setLabel('Statistics')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('blacklist:sync')
      .setLabel('Resync Roles')
      .setStyle(ButtonStyle.Danger)
  );

  return [actionRow, utilityRow];
}

function buildMenuEmbed() {
  const entries = readBlacklist();
  const latestEntry = entries
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];

  return new EmbedBuilder()
    .setColor(0xe30000)
    .setTitle('Blacklist Control Panel')
    .setDescription('Manage blacklist records directly inside Discord. User actions open a searchable member picker with an ID fallback.')
    .addFields(
      { name: 'Active Entries', value: String(entries.length), inline: true },
      { name: 'Role Action', value: 'Remove roles, then blacklist', inline: true },
      { name: 'Admin Replies', value: 'Private', inline: true },
      {
        name: 'Latest Entry',
        value: latestEntry
          ? `<@${latestEntry.userId}> - ${truncate(latestEntry.reason, 120)}`
          : 'No blacklist entries yet.',
        inline: false
      }
    )
    .setFooter({ text: 'Choose an action below to continue.' })
    .setTimestamp();
}

function buildTextInput(customId, label, placeholder, style = TextInputStyle.Short, maxLength = 100) {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(style)
    .setRequired(true)
    .setMaxLength(maxLength);
}

function buildModal(action) {
  if (action === 'add') {
    return new ModalBuilder()
      .setCustomId('blacklist:modal:add')
      .setTitle('Add / Update Blacklist')
      .addComponents(
        new ActionRowBuilder().addComponents(
          buildTextInput('user', 'Discord user ID or mention', '123456789012345678 or @username')
        ),
        new ActionRowBuilder().addComponents(
          buildTextInput('reason', 'Blacklist reason', 'Reason shown in logs', TextInputStyle.Paragraph, 1000)
        )
      );
  }

  if (action === 'remove') {
    return new ModalBuilder()
      .setCustomId('blacklist:modal:remove')
      .setTitle('Remove From Blacklist')
      .addComponents(
        new ActionRowBuilder().addComponents(
          buildTextInput('user', 'Discord user ID or mention', '123456789012345678 or @username')
        )
      );
  }

  if (action === 'check') {
    return new ModalBuilder()
      .setCustomId('blacklist:modal:check')
      .setTitle('Check Blacklist')
      .addComponents(
        new ActionRowBuilder().addComponents(
          buildTextInput('user', 'Discord user ID or mention', '123456789012345678 or @username')
        )
      );
  }

  return null;
}

function buildAddReasonModal(userId) {
  return new ModalBuilder()
    .setCustomId(`blacklist:modal:addSelected:${userId}`)
    .setTitle('Blacklist Reason')
    .addComponents(
      new ActionRowBuilder().addComponents(
        buildTextInput('reason', 'Blacklist reason', 'Reason shown in logs', TextInputStyle.Paragraph, 1000)
      )
    );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

function isAdminMember(member) {
  if (!member) {
    return false;
  }

  if (config.adminUserIds.includes(member.id)) {
    return true;
  }

  if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  return config.adminRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function safeReply(interaction, payload) {
  const response = {
    ephemeral: true,
    ...payload
  };

  try {
    if (interaction.deferred && !interaction.replied) {
      const { ephemeral, ...editPayload } = response;
      await interaction.editReply(editPayload);
    } else if (interaction.replied) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  } catch (error) {
    logError('Failed to send interaction response.', error);
  }
}

async function requireAdmin(interaction) {
  if (!interaction.guild || !interaction.member) {
    await safeReply(interaction, { content: 'Use blacklist administration inside a Discord server.' });
    return false;
  }

  if (!isAdminMember(interaction.member)) {
    await safeReply(interaction, { content: 'You do not have permission to use blacklist administration.' });
    return false;
  }

  return true;
}

function getBotMember(guild) {
  return guild.members.me || guild.members.cache.get(client.user.id);
}

async function validateGuildConfig(guild) {
  const errors = [];
  const warnings = [];
  const botMember = getBotMember(guild) || await guild.members.fetchMe().catch(() => null);

  if (!botMember) {
    errors.push('Could not load the bot member in this server.');
    return { errors, warnings };
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    errors.push('The bot is missing the Manage Roles permission.');
  }

  const blacklistRole = await guild.roles.fetch(config.blacklistRoleId).catch(() => null);
  if (!blacklistRole) {
    errors.push('blacklistRoleId does not exist in this server.');
  } else if (botMember.roles.highest.comparePositionTo(blacklistRole) <= 0) {
    errors.push('The bot role must be above the blacklist role in the server role list.');
  }

  for (const roleId of config.adminRoleIds) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      warnings.push(`Admin role ${roleId} does not exist in this server.`);
    }
  }

  const logChannel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!logChannel || ![
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement
  ].includes(logChannel.type)) {
    errors.push('logChannelId must be a text or announcement channel in this server.');
  } else {
    const channelPermissions = logChannel.permissionsFor(botMember);
    if (!channelPermissions?.has(PermissionFlagsBits.ViewChannel)) {
      errors.push('The bot cannot view the configured log channel.');
    }
    if (!channelPermissions?.has(PermissionFlagsBits.SendMessages)) {
      errors.push('The bot cannot send messages in the configured log channel.');
    }
  }

  return { errors, warnings };
}

async function sendLog(guild, embed) {
  try {
    const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      logWarn('Configured log channel was not found or is not text-based.');
      return false;
    }

    await channel.send({ embeds: [embed] });
    return true;
  } catch (error) {
    logError('Failed to send blacklist log embed.', error);
    return false;
  }
}

async function fetchUserTag(userId) {
  const user = await client.users.fetch(userId).catch(() => null);
  return user?.tag || `User ${userId}`;
}

async function assignBlacklistRole(member, reason) {
  if (!member) {
    return { ok: false, status: 'not_in_guild' };
  }

  const botMember = getBotMember(member.guild) || await member.guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return { ok: false, status: 'failed', error: new Error('Could not load bot member.') };
  }

  const removableRoles = member.roles.cache.filter((role) => {
    if (role.id === member.guild.id || role.id === config.blacklistRoleId) {
      return false;
    }

    if (role.managed) {
      return false;
    }

    return botMember.roles.highest.comparePositionTo(role) > 0;
  });
  const skippedRoles = member.roles.cache.filter((role) => {
    if (role.id === member.guild.id || role.id === config.blacklistRoleId) {
      return false;
    }

    return !removableRoles.has(role.id);
  });
  let removedRoleCount = 0;

  try {
    if (removableRoles.size) {
      await member.roles.remove([...removableRoles.keys()], `${reason} Removing roles before blacklist.`);
      removedRoleCount = removableRoles.size;
    }

    if (member.roles.cache.has(config.blacklistRoleId)) {
      return {
        ok: true,
        status: 'already_has_role',
        removedRoleCount,
        skippedRoleCount: skippedRoles.size
      };
    }

    await member.roles.add(config.blacklistRoleId, reason);
    return {
      ok: true,
      status: 'assigned',
      removedRoleCount,
      skippedRoleCount: skippedRoles.size
    };
  } catch (error) {
    logError(`Failed to apply blacklist role state to ${member.id}.`, error);
    return {
      ok: false,
      status: 'failed',
      error,
      removedRoleCount,
      skippedRoleCount: skippedRoles.size
    };
  }
}

async function removeBlacklistRole(member, reason) {
  if (!member || !member.roles.cache.has(config.blacklistRoleId)) {
    return { ok: true, status: 'no_role' };
  }

  try {
    await member.roles.remove(config.blacklistRoleId, reason);
    return { ok: true, status: 'removed' };
  } catch (error) {
    logError(`Failed to remove blacklist role from ${member.id}.`, error);
    return { ok: false, status: 'failed', error };
  }
}

async function dmBlacklistedMember(member, entry) {
  if (!config.dmBlacklistedUsers || !member) {
    return;
  }

  await member
    .send(`You are blacklisted on **${member.guild.name}**. Reason: ${entry.reason}`)
    .catch((error) => logWarn(`Could not DM blacklisted user ${member.id}: ${error.message}`));
}

async function handleBlacklistedMember(member, entry, actionText) {
  const roleResult = await assignBlacklistRole(member, 'User is blacklisted.');
  await sendLog(member.guild, buildLogEmbed(entry, actionText, entry.blacklistedByTag));
  await dmBlacklistedMember(member, entry);
  return roleResult;
}

async function showMenu(interaction) {
  if (!(await requireAdmin(interaction))) {
    return;
  }

  await safeReply(interaction, {
    embeds: [buildMenuEmbed()],
    components: buildMenuComponents()
  });
}

function buildListEmbed() {
  const entries = readBlacklist()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 10);

  if (!entries.length) {
    return buildSimpleEmbed('Blacklist Entries', 'The blacklist is empty.');
  }

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle('Recent Blacklist Entries')
    .setDescription(
      entries
        .map((entry, index) => {
          return `**${index + 1}.** <@${entry.userId}>\nReason: ${truncate(entry.reason, 140)}\nDate: ${formatDate(entry.blacklistedAt)}`;
        })
        .join('\n\n')
    )
    .setTimestamp();
}

async function buildStatsEmbed(guild) {
  const entries = readBlacklist();
  await guild.members.fetch().catch((error) => logWarn(`Could not fetch all guild members for stats: ${error.message}`));
  const role = await guild.roles.fetch(config.blacklistRoleId).catch(() => null);
  const membersWithRole = role?.members?.size ?? 0;

  let presentInGuild = 0;
  for (const entry of entries) {
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    if (member) {
      presentInGuild += 1;
    }
  }

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle('Blacklist Statistics')
    .addFields(
      { name: 'Total Entries', value: String(entries.length), inline: true },
      { name: 'Currently In Server', value: String(presentInGuild), inline: true },
      { name: 'Members With Role', value: String(membersWithRole), inline: true },
      { name: 'Role Cleanup On Remove', value: config.removeBlacklistRoleOnUnblacklist ? 'Enabled' : 'Disabled', inline: true },
      { name: 'DM Blacklisted Users', value: config.dmBlacklistedUsers ? 'Enabled' : 'Disabled', inline: true }
    )
    .setTimestamp();
}

async function resyncBlacklistRoles(guild) {
  const validation = await validateGuildConfig(guild);
  if (validation.errors.length) {
    return {
      ok: false,
      message: `Cannot resync roles:\n- ${validation.errors.join('\n- ')}`
    };
  }

  const entries = readBlacklist();
  const blacklistedIds = new Set(entries.map((entry) => entry.userId));
  const result = {
    checked: entries.length,
    assigned: 0,
    alreadyAssigned: 0,
    notInGuild: 0,
    failedAssignments: 0,
    rolesRemoved: 0,
    rolesSkipped: 0,
    staleRemoved: 0,
    failedRemovals: 0
  };

  for (const entry of entries) {
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    if (!member) {
      result.notInGuild += 1;
      continue;
    }

    const roleResult = await assignBlacklistRole(member, 'Blacklist role resync.');
    result.rolesRemoved += roleResult.removedRoleCount || 0;
    result.rolesSkipped += roleResult.skippedRoleCount || 0;

    if (roleResult.status === 'assigned') {
      result.assigned += 1;
    } else if (roleResult.status === 'already_has_role') {
      result.alreadyAssigned += 1;
    } else if (!roleResult.ok) {
      result.failedAssignments += 1;
    }
  }

  if (config.removeBlacklistRoleOnUnblacklist) {
    await guild.members.fetch().catch((error) => logWarn(`Could not fetch all guild members for stale role cleanup: ${error.message}`));
    const role = await guild.roles.fetch(config.blacklistRoleId).catch(() => null);
    const roleMembers = role ? [...role.members.values()] : [];

    for (const member of roleMembers) {
      if (blacklistedIds.has(member.id)) {
        continue;
      }

      const removeResult = await removeBlacklistRole(member, 'Removing stale blacklist role during resync.');
      if (removeResult.status === 'removed') {
        result.staleRemoved += 1;
      } else if (!removeResult.ok) {
        result.failedRemovals += 1;
      }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(result.failedAssignments || result.failedRemovals ? 0xf2c94c : 0x27ae60)
    .setTitle('Blacklist Role Resync Complete')
    .addFields(
      { name: 'Entries Checked', value: String(result.checked), inline: true },
      { name: 'Roles Assigned', value: String(result.assigned), inline: true },
      { name: 'Already Blacklisted', value: String(result.alreadyAssigned), inline: true },
      { name: 'Not In Server', value: String(result.notInGuild), inline: true },
      { name: 'Assignment Failures', value: String(result.failedAssignments), inline: true },
      { name: 'Roles Removed', value: String(result.rolesRemoved), inline: true },
      { name: 'Roles Skipped', value: String(result.rolesSkipped), inline: true },
      { name: 'Stale Roles Removed', value: String(result.staleRemoved), inline: true },
      { name: 'Removal Failures', value: String(result.failedRemovals), inline: true }
    )
    .setTimestamp();

  await sendLog(guild, embed);
  return { ok: true, embed };
}

async function handleAction(interaction, action) {
  if (!(await requireAdmin(interaction))) {
    return;
  }

  if (['add', 'remove', 'check'].includes(action)) {
    await safeReply(interaction, {
      embeds: [buildTargetSelectionEmbed(action)],
      components: buildTargetSelectionComponents(action)
    });
    return;
  }

  if (action === 'list') {
    await safeReply(interaction, { embeds: [buildListEmbed()] });
    return;
  }

  if (action === 'stats') {
    await safeReply(interaction, { embeds: [await buildStatsEmbed(interaction.guild)] });
    return;
  }

  if (action === 'sync') {
    await interaction.deferReply({ ephemeral: true });
    const result = await resyncBlacklistRoles(interaction.guild);
    if (result.ok) {
      await safeReply(interaction, { embeds: [result.embed] });
    } else {
      await safeReply(interaction, { content: result.message });
    }
  }
}

async function handleIdFallbackButton(interaction, action) {
  if (!(await requireAdmin(interaction))) {
    return;
  }

  const modal = buildModal(action);
  if (!modal) {
    await safeReply(interaction, { content: 'Unknown blacklist action.' });
    return;
  }

  await interaction.showModal(modal);
}

async function handleUserSelection(interaction) {
  if (!(await requireAdmin(interaction))) {
    return;
  }

  const action = interaction.customId.replace('blacklist:user:', '');
  const userId = interaction.values[0];

  if (!normalizeUserId(userId)) {
    await safeReply(interaction, { content: 'Discord returned an invalid user ID.' });
    return;
  }

  if (action === 'add') {
    await interaction.showModal(buildAddReasonModal(userId));
    return;
  }

  if (action === 'remove') {
    await removeUserFromBlacklist(interaction, userId);
    return;
  }

  if (action === 'check') {
    await checkBlacklistUser(interaction, userId);
  }
}

async function addUserToBlacklist(interaction, userId, reason) {
  const tag = await fetchUserTag(userId);
  const { entry, updated } = upsertBlacklistEntry({
    userId,
    tag,
    reason,
    admin: interaction.user
  });

  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  const roleResult = member
    ? await handleBlacklistedMember(member, entry, 'You have been added to the active blacklist.')
    : { ok: true, status: 'not_in_guild', removedRoleCount: 0, skippedRoleCount: 0 };

  if (!member) {
    await sendLog(interaction.guild, buildLogEmbed(entry, 'You have been added to the active blacklist.', interaction.user.tag));
  }

  const roleMessage = roleResult.status === 'assigned'
    ? 'The blacklist role was assigned.'
    : roleResult.status === 'already_has_role'
      ? 'The user already had the blacklist role.'
      : roleResult.status === 'not_in_guild'
        ? 'The role will be assigned when the user joins.'
        : 'The entry was saved, but role assignment failed. Check bot permissions and role hierarchy.';
  const cleanupMessage = member
    ? ` Removed roles: ${roleResult.removedRoleCount || 0}. Skipped unmanageable roles: ${roleResult.skippedRoleCount || 0}.`
    : '';

  await safeReply(interaction, {
    content: `${updated ? 'Updated' : 'Added'} <@${userId}>. ${roleMessage}${cleanupMessage}`
  });
}

async function removeUserFromBlacklist(interaction, userId) {
  const removed = removeBlacklistEntry(userId);
  if (!removed) {
    await safeReply(interaction, { content: `<@${userId}> is not blacklisted.` });
    return;
  }

  let roleMessage = 'Role cleanup is disabled.';
  if (config.removeBlacklistRoleOnUnblacklist) {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    const roleResult = await removeBlacklistRole(member, 'User was removed from the blacklist.');
    roleMessage = roleResult.status === 'removed'
      ? 'The blacklist role was removed.'
      : roleResult.status === 'no_role'
        ? 'No blacklist role needed to be removed.'
        : 'The entry was removed, but role removal failed. Check bot permissions and role hierarchy.';
  }

  await sendLog(
    interaction.guild,
    buildSimpleEmbed('Blacklist Entry Removed', `<@${userId}> was removed from the blacklist by <@${interaction.user.id}>.`, 0x27ae60)
  );

  await safeReply(interaction, {
    content: `Removed <@${userId}> from the blacklist. ${roleMessage}`
  });
}

async function checkBlacklistUser(interaction, userId) {
  const entry = findBlacklistEntry(userId);
  if (!entry) {
    await safeReply(interaction, { content: `<@${userId}> is not blacklisted.` });
    return;
  }

  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  await safeReply(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(0xe30000)
        .setTitle('Blacklist Check')
        .addFields(
          { name: 'User', value: `<@${entry.userId}>`, inline: false },
          { name: 'Reason', value: entry.reason, inline: false },
          { name: 'Blacklisted By', value: normalizeUserId(entry.blacklistedById) ? `<@${entry.blacklistedById}>` : entry.blacklistedByTag, inline: true },
          { name: 'Blacklist Date', value: formatDate(entry.blacklistedAt), inline: true },
          { name: 'In Server', value: member ? 'Yes' : 'No', inline: true },
          { name: 'Has Role', value: member?.roles.cache.has(config.blacklistRoleId) ? 'Yes' : 'No', inline: true }
        )
        .setTimestamp()
    ]
  });
}

async function handleAddModal(interaction) {
  const userId = normalizeUserId(interaction.fields.getTextInputValue('user'));
  const reason = interaction.fields.getTextInputValue('reason').trim();

  if (!userId) {
    await safeReply(interaction, { content: 'Please enter a valid Discord user ID or mention.' });
    return;
  }

  if (!reason) {
    await safeReply(interaction, { content: 'Please enter a blacklist reason.' });
    return;
  }

  await addUserToBlacklist(interaction, userId, reason);
}

async function handleAddSelectedModal(interaction) {
  const userId = normalizeUserId(interaction.customId.replace('blacklist:modal:addSelected:', ''));
  const reason = interaction.fields.getTextInputValue('reason').trim();

  if (!userId) {
    await safeReply(interaction, { content: 'The selected Discord user is no longer valid.' });
    return;
  }

  if (!reason) {
    await safeReply(interaction, { content: 'Please enter a blacklist reason.' });
    return;
  }

  await addUserToBlacklist(interaction, userId, reason);
}

async function handleRemoveModal(interaction) {
  const userId = normalizeUserId(interaction.fields.getTextInputValue('user'));

  if (!userId) {
    await safeReply(interaction, { content: 'Please enter a valid Discord user ID or mention.' });
    return;
  }

  await removeUserFromBlacklist(interaction, userId);
}

async function handleCheckModal(interaction) {
  const userId = normalizeUserId(interaction.fields.getTextInputValue('user'));

  if (!userId) {
    await safeReply(interaction, { content: 'Please enter a valid Discord user ID or mention.' });
    return;
  }

  await checkBlacklistUser(interaction, userId);
}

async function handleModal(interaction) {
  if (!(await requireAdmin(interaction))) {
    return;
  }

  if (interaction.customId === 'blacklist:modal:add') {
    await handleAddModal(interaction);
    return;
  }

  if (interaction.customId.startsWith('blacklist:modal:addSelected:')) {
    await handleAddSelectedModal(interaction);
    return;
  }

  if (interaction.customId === 'blacklist:modal:remove') {
    await handleRemoveModal(interaction);
    return;
  }

  if (interaction.customId === 'blacklist:modal:check') {
    await handleCheckModal(interaction);
  }
}

async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('blacklist')
      .setDescription('Open the secure blacklist administration menu.')
      .setDMPermission(false)
      .toJSON()
  ];

  if (config.discordGuildId) {
    const guild = await client.guilds.fetch(config.discordGuildId).catch(() => null);
    if (!guild) {
      throw new Error(`Configured discordGuildId ${config.discordGuildId} was not found for this bot.`);
    }

    await guild.commands.set(commands);
    logInfo(`Registered /blacklist in guild ${guild.id}.`);
    return;
  }

  await client.application.commands.set(commands);
  logInfo('Registered /blacklist globally.');
}

async function validateAllGuilds() {
  const guilds = config.discordGuildId
    ? [await client.guilds.fetch(config.discordGuildId).catch(() => null)].filter(Boolean)
    : [...client.guilds.cache.values()];

  for (const guild of guilds) {
    const validation = await validateGuildConfig(guild);
    for (const warning of validation.warnings) {
      logWarn(`${guild.name}: ${warning}`);
    }
    if (validation.errors.length) {
      logWarn(`${guild.name}: configuration issues:\n- ${validation.errors.join('\n- ')}`);
    } else {
      logInfo(`${guild.name}: configuration validated.`);
    }
  }
}

client.once('ready', async () => {
  logInfo(`Logged in as ${client.user.tag}.`);
  logInfo(`Loaded config from ${CONFIG_PATH}.`);

  try {
    await registerSlashCommands();
    await validateAllGuilds();
  } catch (error) {
    logError('Startup validation or command registration failed.', error);
  }
});

client.on('guildMemberAdd', async (member) => {
  const entry = findBlacklistEntry(member.id);
  if (!entry) {
    return;
  }

  await handleBlacklistedMember(
    member,
    entry,
    'A blacklisted user joined the server. Existing roles were removed and the blacklist role was assigned.'
  ).catch((error) => logError(`Failed to process joining blacklisted member ${member.id}.`, error));
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'blacklist') {
      await showMenu(interaction);
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('blacklist:user:')) {
      await handleUserSelection(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('blacklist:id:')) {
      await handleIdFallbackButton(interaction, interaction.customId.replace('blacklist:id:', ''));
      return;
    }

    if (interaction.isButton() && interaction.customId === 'blacklist:back') {
      await showMenu(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('blacklist:')) {
      await handleAction(interaction, interaction.customId.replace('blacklist:', ''));
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('blacklist:modal:')) {
      await handleModal(interaction);
    }
  } catch (error) {
    logError('Interaction handling failed.', error);
    await safeReply(interaction, {
      content: 'Something went wrong while processing that blacklist action. Check the bot console for details.'
    });
  }
});

process.on('unhandledRejection', (error) => {
  logError('Unhandled promise rejection.', error);
});

process.on('uncaughtException', (error) => {
  logError('Uncaught exception.', error);
});

try {
  validateStaticConfig();
  ensureDataFile();
  client.login(config.discordToken).catch((error) => {
    logError('Discord login failed. Check the bot token and enabled intents.', error);
    process.exitCode = 1;
  });
} catch (error) {
  logError(error.message);
  process.exitCode = 1;
}
