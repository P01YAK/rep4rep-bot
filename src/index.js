import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import dotenv from 'dotenv';
import api from './api.js';

process.removeAllListeners('warning');

dotenv.config();

// Add console colors
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    white: '\x1b[37m'
};

// Create colored log functions
function logInfo(message) {
    console.log(`${colors.white}${message}${colors.reset}`);
}

function logSuccess(message) {
    console.log(`${colors.green}${message}${colors.reset}`);
}

function logError(message) {
    console.error(`${colors.red}${message}${colors.reset}`);
}

function askQuestion(query) {
    const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        readline.question(query, (answer) => {
            readline.close();
            resolve(answer);
        });
    });
}

function loadAccounts() {
    if (!existsSync('accounts.json')) {
        writeFileSync('accounts.json', JSON.stringify([]), 'utf8');
    }
    return JSON.parse(readFileSync('accounts.json', 'utf8'));
}

function saveAccounts(accounts) {
    writeFileSync('accounts.json', JSON.stringify(accounts, null, 2), 'utf8');
}

function getAccount(accounts, login) {
    return accounts.find((acc) => acc.login === login);
}

function updateAccount(accounts, login, updates) {
    const account = getAccount(accounts, login);
    if (account) {
        Object.assign(account, updates);
    } else {
        accounts.push({ login, ...updates });
    }
    saveAccounts(accounts);
}

async function processAccount(account) {
    const user = new SteamUser({ renewRefreshTokens: true });
    const community = new SteamCommunity();
    const accounts = loadAccounts();

    let isLoggedOn = false;
    let isTokenRefreshed = account.refreshToken ? true : false;

    try {
        await new Promise((resolve, reject) => {
            let logOnOptions = {};
            if (account.refreshToken) {
                logOnOptions = { refreshToken: account.refreshToken };
            } else {
                logOnOptions = { accountName: account.login, password: account.password };
            }

            user.logOn(logOnOptions);

            user.on('loggedOn', async () => {
                logSuccess(`[${account.login}] Successfully logged into the account.`);
                isLoggedOn = true;

                user.setPersona(7);

                user.on('webSession', async (sessionID, cookies) => {
                    community.setCookies(cookies);
                    logSuccess(`[${account.login}] Web session obtained.`);

                    await autoComment(user.steamID.getSteamID64(), account, community, accounts);

                    logInfo(`[${account.login}] Logging out of the account.`);
                    user.logOff();

                    user.once('disconnected', () => {
                        logInfo(`[${account.login}] Logout completed.`);
                        resolve();
                    });
                });
            });

            user.on('refreshToken', (newToken) => {
                logSuccess(`[${account.login}] New token received: ${newToken}`);
                updateAccount(accounts, account.login, { refreshToken: newToken });
                isTokenRefreshed = true;

                if (isLoggedOn) {
                    resolve();
                }
            });

            user.on('error', (e) => {
                logError(`[${account.login}] Login error: ${e.message}`);
                if (e.eresult === 5) {
                    logError(`[${account.login}] Incorrect password or account data.`);
                } else if (e.eresult === 63) {
                    logError(`[${account.login}] Account is locked due to Steam Guard. Check your email.`);
                } else if (e.message.includes("You've been posting too frequently")) {
                    logError(`[${account.login}] Too frequent comments. Resetting the counter.`);
                    updateAccount(accounts, account.login, { commentCounter: 0, lastComment: new Date().toISOString() });
                }
                reject(e);
            });

            if (!account.refreshToken) {
                isTokenRefreshed = false;
            }
        });
    } catch (error) {
        logError(`[${account.login}] Error processing account: ${error.message}`);
    }
}

async function autoComment(steamID, account, community, accounts) {
    try {
        logInfo(`[${account.login}] Starting the comment process...`);

        if (account.lastComment) {
            const lastCommentTime = new Date(account.lastComment).getTime();
            const currentTime = Date.now();
            const timeSinceLastComment = currentTime - lastCommentTime;
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (timeSinceLastComment < twentyFourHours) {
                logInfo(`[${account.login}] Not ready yet (last comment was less than 24 hours ago).`);
                return;
            }
        }

        updateAccount(accounts, account.login, { commentCounter: 0 });

        let repSteamProfiles = [];
        let repSteamProfilesObj = {};

        logInfo(`[${account.login}] Getting steam profiles from rep4rep...`);
        const steamProfilesResponse = await api.getSteamProfiles();
        
        let steamProfiles;
        // Try to extract profiles from different possible response structures
        if (typeof steamProfilesResponse === 'object') {
            if (Array.isArray(steamProfilesResponse)) {
                steamProfiles = steamProfilesResponse;
            } else if (steamProfilesResponse.data && Array.isArray(steamProfilesResponse.data)) {
                steamProfiles = steamProfilesResponse.data;
            } else if (steamProfilesResponse.profiles && Array.isArray(steamProfilesResponse.profiles)) {
                steamProfiles = steamProfilesResponse.profiles;
            } else if (steamProfilesResponse.steamProfiles && Array.isArray(steamProfilesResponse.steamProfiles)) {
                steamProfiles = steamProfilesResponse.steamProfiles;
            } else {
                logError(`[${account.login}] Error: steamProfiles is not in an expected format: ${JSON.stringify(steamProfilesResponse).substring(0, 200) + '...'}`);
                return;
            }
        } else {
            logError(`[${account.login}] Error: steamProfiles response is not an object: ${steamProfilesResponse}`);
            return;
        }

        steamProfiles.forEach((steamProfile) => {
            repSteamProfiles.push(steamProfile.steamId);
            repSteamProfilesObj[steamProfile.steamId] = steamProfile.id;
        });

        if (!repSteamProfiles.includes(steamID)) {
            logInfo(`[${account.login}] Account not added to rep4rep! Adding now...`);
            await api.addSteamProfile(steamID);
            logInfo(`[${account.login}] Getting steam profiles after adding the profile...`);
            const updatedSteamProfilesResponse = await api.getSteamProfiles();

            let updatedSteamProfiles;
            // Try to extract profiles from different possible response structures
            if (typeof updatedSteamProfilesResponse === 'object') {
                if (Array.isArray(updatedSteamProfilesResponse)) {
                    updatedSteamProfiles = updatedSteamProfilesResponse;
                } else if (updatedSteamProfilesResponse.data && Array.isArray(updatedSteamProfilesResponse.data)) {
                    updatedSteamProfiles = updatedSteamProfilesResponse.data;
                } else if (updatedSteamProfilesResponse.profiles && Array.isArray(updatedSteamProfilesResponse.profiles)) {
                    updatedSteamProfiles = updatedSteamProfilesResponse.profiles;
                } else if (updatedSteamProfilesResponse.steamProfiles && Array.isArray(updatedSteamProfilesResponse.steamProfiles)) {
                    updatedSteamProfiles = updatedSteamProfilesResponse.steamProfiles;
                } else {
                    logError(`[${account.login}] Error: updatedSteamProfiles is not in an expected format: ${JSON.stringify(updatedSteamProfilesResponse).substring(0, 200) + '...'}`);
                    return;
                }
            } else {
                logError(`[${account.login}] Error: updatedSteamProfiles response is not an object: ${updatedSteamProfilesResponse}`);
                return;
            }

            updatedSteamProfiles.forEach((steamProfile) => {
                repSteamProfiles.push(steamProfile.steamId);
                repSteamProfilesObj[steamProfile.steamId] = steamProfile.id;
            });
        }

        logInfo(`[${account.login}] Getting tasks...`);
        const tasks = await api.getTasks(repSteamProfilesObj[steamID]);
        let successfulComments = 0;
        const maxComments = 10;

        for (const task of tasks) {
            if (successfulComments >= maxComments) {
                logInfo(`[${account.login}] Reached the limit of ${maxComments} comments. Stopping.`);
                break;
            }

            logInfo(
                `[${account.login}] Posting a comment on the profile: https://steamcommunity.com/profiles/${task.targetSteamProfileId}\nComment: ${task.requiredCommentText}`
            );

            const result = await new Promise((resolve) => {
                community.postUserComment(task.targetSteamProfileId, task.requiredCommentText, (err) => {
                    if (err) {
                        logError(`[${account.login}] Failed to post a comment on the profile: ${task.targetSteamProfileId}`);
                        logError(err.message);
                        if (err.message.includes("The settings on this account do not allow you to add comments")) {
                            logInfo(`[${account.login}] Profile is private. Moving to the next task.`);
                            resolve(false);
                        } else if (err.message.includes("You've been posting too frequently")) {
                            logError(`[${account.login}] Too frequent comments. Stopping the account.`);
                            updateAccount(accounts, account.login, { commentCounter: 0, lastComment: new Date().toISOString() });
                            resolve("stop");
                        } else {
                            logInfo(`[${account.login}] Unable to post comment. Moving to the next task.`);
                            resolve(false);
                        }
                    } else {
                        logSuccess(`[${account.login}] Comment posted successfully!`);
                        resolve(true);
                    }
                });
            });

            if (result === "stop") {
                break;
            } else if (result === false) {
                // Just move to the next task
            } else if (result === true) {
                await api.completeTask(task.taskId, task.requiredCommentId, repSteamProfilesObj[steamID]);
                logSuccess(`[${account.login}] The comment will be reviewed shortly...`);
                successfulComments++;
            }

            await sleep(15000);
        }

        logSuccess(`[${account.login}] Comment process completed.`);
        updateAccount(accounts, account.login, { lastComment: new Date().toISOString() });
    } catch (error) {
        logError(`[${account.login}] Error in the auto comment function for SteamID: ${steamID}: ${error.message}`);
    }
}

function sleep(millis) {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

async function startWork() {
    const accounts = loadAccounts();
    for (const account of accounts) {
        if (!account.steamID) {
            logInfo(`[${account.login}] No SteamID for the account. Skipping.`);
            continue;
        }

        if (account.lastComment) {
            const lastCommentTime = new Date(account.lastComment).getTime();
            const currentTime = Date.now();
            const timeSinceLastComment = currentTime - lastCommentTime;
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (timeSinceLastComment < twentyFourHours) {
                logInfo(`[${account.login}] Not ready yet (last comment was less than 24 hours ago). Skipping.`);
                continue;
            }
        }
        await processAccount(account);
    }
}

async function addAccount() {
    try {
        const credentials = await askQuestion('Enter login:pass: ');
        const [username, password] = credentials.split(':');
        if (!username || !password) {
            logError('Invalid format. Enter data in the format login:pass.');
            return;
        }

        const accounts = loadAccounts();
        if (getAccount(accounts, username)) {
            logError(`[${username}] Account already exists.`);
            return;
        }

        const user = new SteamUser({ renewRefreshTokens: true });

        await new Promise((resolve, reject) => {
            let logOnOptions = { accountName: username, password };

            user.logOn(logOnOptions);

            let steamID = null;
            let refreshToken = null;

            user.on('loggedOn', async () => {
                logSuccess(`[${username}] Successfully logged into the account.`);
                steamID = user.steamID.getSteamID64();
                logSuccess(`[${username}] Received SteamID: ${steamID}`);

                if (refreshToken) {
                    const accountData = { login: username, password, refreshToken, commentCounter: 0, lastComment: null, steamID };
                    updateAccount(accounts, username, accountData);
                    logSuccess(`[${username}] Account successfully added with SteamID: ${steamID} and refreshToken.`);
                    resolve();
                }
            });

            user.on('refreshToken', (newToken) => {
                logSuccess(`[${username}] New token received: ${newToken}`);
                refreshToken = newToken;

                if (steamID) {
                    const accountData = { login: username, password, refreshToken, commentCounter: 0, lastComment: null, steamID };
                    updateAccount(accounts, username, accountData);
                    logSuccess(`[${username}] Account successfully added with SteamID: ${steamID} and refreshToken.`);
                    resolve();
                }
            });

            user.on('error', (e) => {
                logError(`[${username}] Login error: ${e.message}`);
                if (e.eresult === 5) {
                    logError(`[${username}] Incorrect password or account data.`);
                } else if (e.eresult === 63) {
                    logError(`[${username}] Account is locked due to Steam Guard. Check your email.`);
                } else if (e.message.includes("You've been posting too frequently")) {
                    logError(`[${username}] Too frequent comments. Resetting the counter.`);
                    updateAccount(accounts, username, { commentCounter: 0, lastComment: new Date().toISOString() });
                }
                reject(e);
            });

            user.on('disconnected', () => {
                logInfo(`[${username}] Logout completed.`);
            });
        });
    } catch (error) {
        logError(`[${username}] Error adding account: ${error.message}`);
    }
}

function viewAccounts() {
    const accounts = loadAccounts();
    logInfo('List of accounts:');
    accounts.forEach((account) => {
        const lastComment = account.lastComment ? new Date(account.lastComment).toLocaleString() : 'Not set';
        const canPostComments = account.lastComment ? Date.now() - new Date(account.lastComment).getTime() > 24 * 60 * 60 * 1000 : true;
        if (canPostComments) {
            logSuccess(`Login: ${account.login}, SteamID: ${account.steamID || 'Not set'}, Allowed to post comments: Yes`);
        } else {
            logInfo(`Login: ${account.login}, SteamID: ${account.steamID || 'Not set'}, Allowed to post comments: No (last comment: ${lastComment})`);
        }
    });
}

async function main() {
    while (true) {
        logInfo('\nChoose an action:');
        logInfo('1 - Start work');
        logInfo('2 - Add accounts');
        logInfo('3 - View accounts');
        logInfo('0 - Exit');

        const choice = await askQuestion('Enter the action number: ');

        switch (choice) {
            case '1':
                await startWork();
                break;
            case '2':
                await addAccount();
                break;
            case '3':
                viewAccounts();
                break;
            case '0':
                logSuccess('Exiting the program.');
                process.exit(0);
            default:
                logError('Invalid choice. Try again.');
        }
    }
}

main();