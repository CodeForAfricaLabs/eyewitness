'use strict';

const packageJson = require(`../../package.json`);
const config = require(`config-ninja`).use(`${packageJson.name}-${packageJson.version}-config`);

const BATCH_SIZE = 1000;
const BATCH_DELAY_MS = 1000;
const READ_SERVER_BASE_URL = config.readServer.baseUrl;
const QUEUE_COLLECTION = `BreakingNewsQueuedItem`;

/*
 * Returns the next batch of queued breaking news items, or an empty array if there are none.
 */
async function getBatchOfQueuedItems (database, skip = 0) {

	const recQueueItems = await database.get(QUEUE_COLLECTION, {}, {
		sort: { addedDate: `asc` },
		skip,
		limit: BATCH_SIZE,
	});

	return recQueueItems || [];

}

/*
 * Returns the breaking news messages we need to send to the user.
 */
function constructBreakingNewMessages (recUser, recArticle, MessageObject) {

	const alertMessage = MessageObject.outgoing(recUser, {
		text: `Breaking news!`,
	});

	const carouselMessage = MessageObject.outgoing(recUser, {
		carousel: {
			sharing: true,
			elements: [{
				label: recArticle.title,
				text: recArticle.description,
				imageUrl: recArticle.imageUrl,
				buttons: [{
					type: `url`,
					label: `Read`,
					payload: `${READ_SERVER_BASE_URL}/${recArticle.feedId}/${recArticle._id}/${recUser._id}`,
					sharing: true,
				}],
			}],
		},
		options: [{
			label: `More stories`,
		}, {
			label: `Main menu`,
		}],
	});

	return {
		alertMessage,
		carouselMessage,
	};

}

/*
 * Sends all the queued items recursively.
 */
async function sendQueuedItems (database, MessageObject, sendMessage, skip = 0) {

	// Get the next batch of items.
	const recQueueItems = await getBatchOfQueuedItems(database, skip);
	if (!recQueueItems.length) { return; }

	const expendedQueueItemIds = [];
	const expendedQueueItemData = [];

	// Send each queued item in turn to their respective users.
	for (const recQueueItem of recQueueItems) {
		const { _id, userData, articleData } = recQueueItem;
		const { alertMessage, carouselMessage } = constructBreakingNewMessages(userData, articleData, MessageObject);

		await sendMessage(userData, alertMessage); // eslint-disable-line no-await-in-loop
		await sendMessage(userData, carouselMessage); // eslint-disable-line no-await-in-loop

		expendedQueueItemIds.push(_id);
		expendedQueueItemData.push({ userData, articleData });
	}

	// Mark as received by users.
	const markAsReceivedPromises = expendedQueueItemData.map(({ userData, articleData }) =>
		database.update(`Article`, articleData, {
			$addToSet: { _receivedByUsers: userData._id },
		})
	);

	await Promise.all(markAsReceivedPromises);

	// Delete all the expended item documents from the queue collection.
	await database.deleteWhere(QUEUE_COLLECTION, {
		_id: { $in: expendedQueueItemIds },
	});

	// Send the next batch of items recursively AND without creating a huge function stack.
	const numCompletedItems = skip + BATCH_SIZE;
	const fnRecurse = sendQueuedItems.bind(this, database, MessageObject, sendMessage, numCompletedItems);

	setTimeout(fnRecurse, BATCH_DELAY_MS);

}

/*
 * Returns the next batch of users, or an empty array if there are none.
 */
async function getBatchOfUsers (database, skip = 0) {

	const recUsers = await database.get(`User`, {
		'bot.disabled': { $ne: true },
	}, {
		sort: { _id: `asc` }, // Keep the entire result set in a consistent order between queries.
		skip,
		limit: BATCH_SIZE,
	});

	return recUsers || [];

}

/*
 * Returns the next unread breaking news story for the given user.
 */
async function getNextBreakingNewsForUser (database, recUser) {

	const conditions = {
		_receivedByUsers: { $nin: [ recUser._id ] },
		articleDate: { $gt: recUser.profile.created },
		isPublished: { $ne: false },
		isPriority: true,
	};
	const options = {
		sort: { articleDate: `asc` },
	};

	const recArticle = await database.get(`Article`, conditions, options);

	return recArticle || null;

}

/*
 * Queues all the breaking news articles for all the users that need to be sent out.
 */
async function queueBreakingNewsItems (database, skip = 0) {

	// Get the next batch of users.
	const recUsers = await getBatchOfUsers(database, skip);
	if (!recUsers.length) { return; }

	// Iterate over each user in turn and queue their unread breaking news.
	for (const recUser of recUsers) {
		const recArticle = await getNextBreakingNewsForUser(database, recUser); // eslint-disable-line no-await-in-loop

		if (!recArticle) { continue; }

		await database.insert(QUEUE_COLLECTION, { // eslint-disable-line no-await-in-loop
			userData: recUser,
			articleData: recArticle,
		});
	}

	// Queue the next batch of users recursively AND without creating a huge function stack.
	const numCompletedUsers = skip + BATCH_SIZE;
	const fnRecurse = sendQueuedItems.bind(this, database, numCompletedUsers);

	setTimeout(fnRecurse, BATCH_DELAY_MS);

}

/*
 * Sends the most recent outstanding breaking news stories to users.
 */
async function sendOutstanding (database, MessageObject, sendMessage) {

	// Send out any breaking news stories still in the queue (in case of restart).
	await sendQueuedItems(database, MessageObject, sendMessage);

	// Queue the next batch of breaking news stories to send out.
	await queueBreakingNewsItems(database);

	// Send out the next batch of breaking news stories.
	await sendQueuedItems(database, MessageObject, sendMessage);

}

/*
 * Export.
 */
module.exports = {
	sendOutstanding,
};