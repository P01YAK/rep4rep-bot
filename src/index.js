import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import SteamUser from 'steam-user';
import SteamCommunity from 'steamcommunity';
import dotenv from 'dotenv';
import api from './api.js';

process.removeAllListeners('warning');

dotenv.config();

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
                console.log(`[${account.login}] Successfully logged into the account.`);
                isLoggedOn = true;

                user.setPersona(7);

                user.on('webSession', async (sessionID, cookies) => {
                    community.setCookies(cookies);
                    console.log(`[${account.login}] Web session obtained.`);

                    await autoComment(user.steamID.getSteamID64(), account, community, accounts);

                    console.log(`[${account.login}] Logging out of the account.`);
                    user.logOff();

                    // Use `once` to ensure the event is handled only once
                    user.once('disconnected', () => {
                        console.log(`[${account.login}] Logout completed.`);
                        resolve();
                    });
                });
            });

            user.on('refreshToken', (newToken) => {
                console.log(`[${account.login}] New token received: ${newToken}`);
                updateAccount(accounts, account.login, { refreshToken: newToken });
                isTokenRefreshed = true;

                if (isLoggedOn) {
                    resolve();
                }
            });

            user.on('error', (e) => {
                console.error(`[${account.login}] Login error:`, e.message);
                if (e.eresult === 5) {
                    console.error(`[${account.login}] Incorrect password or account data.`);
                } else if (e.eresult === 63) {
                    console.error(`[${account.login}] Account is locked due to Steam Guard. Check your email.`);
                } else if (e.message.includes("You've been posting too frequently")) {
                    console.error(`[${account.login}] Too frequent comments. Resetting the counter.`);
                    updateAccount(accounts, account.login, { commentCounter: 0, lastComment: new Date().toISOString() });
                }
                reject(e);
            });

            if (!account.refreshToken) {
                isTokenRefreshed = false;
            }
        });
    } catch (error) {
        console.error(`[${account.login}] Error processing account:`, error.message);
    }
}

async function autoComment(steamID, account, community, accounts) {
    try {
        console.log(`[${account.login}] Starting the comment process...`);

        if (account.lastComment) {
            const lastCommentTime = new Date(account.lastComment).getTime();
            const currentTime = Date.now();
            const timeSinceLastComment = currentTime - lastCommentTime;
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (timeSinceLastComment < twentyFourHours) {
                console.log(`[${account.login}] Not ready yet (last comment was less than 24 hours ago).`);
                return;
            }
        }

        updateAccount(accounts, account.login, { commentCounter: 0 });

        let repSteamProfiles = [];
        let repSteamProfilesObj = {};

        console.log(`[${account.login}] Getting steam profiles from rep4rep...`);
        const steamProfiles = await api.getSteamProfiles();
        steamProfiles.forEach((steamProfile) => {
            repSteamProfiles.push(steamProfile.steamId);
            repSteamProfilesObj[steamProfile.steamId] = steamProfile.id;
        });

        if (!repSteamProfiles.includes(steamID)) {
            console.log(`[${account.login}] Account not added to rep4rep! Adding now...`);
            await api.addSteamProfile(steamID);
            console.log(`[${account.login}] Getting steam profiles after adding the profile...`);
            const updatedSteamProfiles = await api.getSteamProfiles();
            updatedSteamProfiles.forEach((steamProfile) => {
                repSteamProfiles.push(steamProfile.steamId);
                repSteamProfilesObj[steamProfile.steamId] = steamProfile.id;
            });
        }

        console.log(`[${account.login}] Getting tasks...`);
        const tasks = await api.getTasks(repSteamProfilesObj[steamID]);
        let successfulComments = 0;
        const maxComments = 10;

        for (const task of tasks) {
            if (successfulComments >= maxComments) {
                console.log(`[${account.login}] Reached the limit of ${maxComments} comments. Stopping.`);
                break;
            }

            let attemptCount = 0;
            const maxAttempts = 3;

            while (attemptCount < maxAttempts) {
                console.log(
                    `[${account.login}] Posting a comment on the profile: https://steamcommunity.com/profiles/${task.targetSteamProfileId}\nComment: ${task.requiredCommentText}`
                );

                const result = await new Promise((resolve) => {
                    community.postUserComment(task.targetSteamProfileId, task.requiredCommentText, (err) => {
                        if (err) {
                            console.log(`[${account.login}] Failed to post a comment on the profile: ${task.targetSteamProfileId}`);
                            console.log(err.message);
                            if (err.message.includes("The settings on this account do not allow you to add comments")) {
                                console.log(`[${account.login}] Retrying due to comment restrictions... (${attemptCount + 1}/${maxAttempts})`);
                                resolve(null);
                            } else if (err.message.includes("You've been posting too frequently")) {
                                console.log(`[${account.login}] Too frequent comments. Stopping the account.`);
                                updateAccount(accounts, account.login, { commentCounter: 0, lastComment: new Date().toISOString() });
                                resolve(false);
                            } else {
                                console.log(`[${account.login}] Retrying due to an unknown error... (${attemptCount + 1}/${maxAttempts})`);
                                resolve(null);
                            }
                        } else {
                            console.log(`[${account.login}] Comment posted successfully!`);
                            resolve(true);
                        }
                    });
                });

                if (result === false) {
                    console.log(`[${account.login}] Stopping the account due to a critical error.`);
                    return;
                } else if (result === true) {
                    await api.completeTask(task.taskId, task.requiredCommentId, repSteamProfilesObj[steamID]);
                    console.log(`[${account.login}] The comment will be reviewed shortly...`);
                    successfulComments++;
                    break;
                } else {
                    attemptCount++;
                    await sleep(5000);
                }
            }

            if (attemptCount >= maxAttempts) {
                console.log(`[${account.login}] Reached the maximum number of attempts. Skipping this task.`);
            }

            await sleep(15000);
        }

        console.log(`[${account.login}] Comment process completed.`);
        updateAccount(accounts, account.login, { lastComment: new Date().toISOString() });
    } catch (error) {
        console.error(`[${account.login}] Error in the auto comment function for SteamID: ${steamID}:`, error.message);
    }
}

function sleep(millis) {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

async function startWork() {
    const accounts = loadAccounts();
    for (const account of accounts) {
        if (!account.steamID) {
            console.log(`[${account.login}] No SteamID for the account. Skipping.`);
            continue;
        }

        if (account.lastComment) {
            const lastCommentTime = new Date(account.lastComment).getTime();
            const currentTime = Date.now();
            const timeSinceLastComment = currentTime - lastCommentTime;
            const twentyFourHours = 24 * 60 * 60 * 1000;

            if (timeSinceLastComment < twentyFourHours) {
                console.log(`[${account.login}] Not ready yet (last comment was less than 24 hours ago). Skipping.`);
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
            console.error('Invalid format. Enter data in the format login:pass.');
            return;
        }

        const accounts = loadAccounts();
        if (getAccount(accounts, username)) {
            console.error(`[${username}] Account already exists.`);
            return;
        }

        const user = new SteamUser({ renewRefreshTokens: true });

        await new Promise((resolve, reject) => {
            let logOnOptions = { accountName: username, password };

            user.logOn(logOnOptions);

            let steamID = null;
            let refreshToken = null;

            user.on('loggedOn', async () => {
                console.log(`[${username}] Successfully logged into the account.`);
                steamID = user.steamID.getSteamID64();
                console.log(`[${username}] Received SteamID: ${steamID}`);

                if (refreshToken) {
                    const accountData = { login: username, password, refreshToken, commentCounter: 0, lastComment: null, steamID };
                    updateAccount(accounts, username, accountData);
                    console.log(`[${username}] Account successfully added with SteamID: ${steamID} and refreshToken.`);
                    resolve();
                }
            });

            user.on('refreshToken', (newToken) => {
                console.log(`[${username}] New token received: ${newToken}`);
                refreshToken = newToken;

                if (steamID) {
                    const accountData = { login: username, password, refreshToken, commentCounter: 0, lastComment: null, steamID };
                    updateAccount(accounts, username, accountData);
                    console.log(`[${username}] Account successfully added with SteamID: ${steamID} and refreshToken.`);
                    resolve();
                }
            });

            user.on('error', (e) => {
                console.error(`[${username}] Login error:`, e.message);
                if (e.eresult === 5) {
                    console.error(`[${username}] Incorrect password or account data.`);
                } else if (e.eresult === 63) {
                    console.error(`[${username}] Account is locked due to Steam Guard. Check your email.`);
                } else if (e.message.includes("You've been posting too frequently")) {
                    console.error(`[${username}] Too frequent comments. Resetting the counter.`);
                    updateAccount(accounts, username, { commentCounter: 0, lastComment: new Date().toISOString() });
                }
                reject(e);
            });

            user.on('disconnected', () => {
                console.log(`[${username}] Logout completed.`);
            });
        });
    } catch (error) {
        console.error('An error occurred:', error.message);
    }
}

function viewAccounts() {
    const accounts = loadAccounts();
    console.log('List of accounts:');
    accounts.forEach((account) => {
        const lastComment = account.lastComment ? new Date(account.lastComment).toLocaleString() : 'Not set';
        const canPostComments = account.lastComment ? Date.now() - new Date(account.lastComment).getTime() > 24 * 60 * 60 * 1000 : true;
        console.log(`Login: ${account.login}, SteamID: ${account.steamID || 'Not set'}, Allowed to post comments: ${canPostComments ? 'Yes' : 'No (last comment: ' + lastComment + ')'}`);
    });
}

async function main() {
    while (true) {
        console.log('\nChoose an action:');
        console.log('1 - Start work');
        console.log('2 - Add accounts');
        console.log('3 - View accounts');
        console.log('0 - Exit');

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
                console.log('Exiting the program.');
                process.exit(0);
            default:
                console.error('Invalid choice. Try again.');
        }
    }
}

main();