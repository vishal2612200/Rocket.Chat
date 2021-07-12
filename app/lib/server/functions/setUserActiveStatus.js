import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import { Accounts } from 'meteor/accounts-base';

import * as Mailer from '../../../mailer';
import { Users, Subscriptions, Rooms } from '../../../models';
import { settings } from '../../../settings';
import { relinquishRoomOwnerships } from './relinquishRoomOwnerships';
import { shouldRemoveOrChangeOwner, getSubscribedRoomsForUserWithDetails } from './getRoomsWithSingleOwner';
import { getUserSingleOwnedRooms } from './getUserSingleOwnedRooms';

function reactivateDirectConversations(userId) {
	// since both users can be deactivated at the same time, we should just reactivate rooms if both users are active
	// for that, we need to fetch the direct messages, fetch the users involved and then the ids of rooms we can reactivate
	const directConversations = Rooms.getDirectConversationsByUserId(userId, { projection: { _id: 1, uids: 1 } }).fetch();
	const userIds = directConversations.reduce((acc, r) => acc.push(...r.uids) && acc, []);
	const uniqueUserIds = [...new Set(userIds)];
	const activeUsers = Users.findActiveByUserIds(uniqueUserIds, { projection: { _id: 1 } }).fetch();
	const activeUserIds = activeUsers.map((u) => u._id);
	const roomsToReactivate = directConversations.reduce((acc, room) => {
		const otherUserId = room.uids.find((u) => u !== userId);
		if (activeUserIds.includes(otherUserId)) {
			acc.push(room._id);
		}
		return acc;
	}, []);

	Rooms.setDmReadOnlyByUserId(userId, roomsToReactivate, false, false);
}

export function setUserActiveStatus(userId, active, confirmRelinquish = false) {
	check(userId, String);
	check(active, Boolean);

	const user = Users.findOneById(userId);

	if (!user) {
		return false;
	}

	// Users without username can't do anything, so there is no need to check for owned rooms
	if (user.username != null && !active) {
		const subscribedRooms = getSubscribedRoomsForUserWithDetails(userId);

		if (shouldRemoveOrChangeOwner(subscribedRooms) && !confirmRelinquish) {
			const rooms = getUserSingleOwnedRooms(subscribedRooms);
			throw new Meteor.Error('user-last-owner', '', rooms);
		}

		relinquishRoomOwnerships(user._id, subscribedRooms, false);
	}

	Users.setUserActive(userId, active);

	if (user.username) {
		Subscriptions.setArchivedByUsername(user.username, !active);
	}

	if (active === false) {
		Users.unsetLoginTokens(userId);
		Rooms.setDmReadOnlyByUserId(userId, undefined, true, false);
	} else {
		Users.unsetReason(userId);
		reactivateDirectConversations(userId);
	}
	if (active && !settings.get('Accounts_Send_Email_When_Activating')) {
		return true;
	}
	if (!active && !settings.get('Accounts_Send_Email_When_Deactivating')) {
		return true;
	}

	const destinations = Array.isArray(user.emails) && user.emails.map((email) => `${ user.name || user.username }<${ email.address }>`);

	const email = {
		to: destinations,
		from: settings.get('From_Email'),
		subject: Accounts.emailTemplates.userActivated.subject({ active }),
		html: Accounts.emailTemplates.userActivated.html({ active, name: user.name, username: user.username }),
	};

	Mailer.sendNoWrap(email);
}
