/**
 * The Claude Code channel bridge (design §5).
 *
 * Other modules import from `$channel`, never from a file inside it.
 */
export {
	BACKOFF_MS,
	CAPABILITIES,
	CHANNEL_NAME,
	INSTRUCTIONS,
	createChannelServer,
	describeAnswer,
	describeAttachments,
	describeReaction,
	describeRise,
	main,
	newClientId,
	quoting,
	readFrames,
	runBridge,
	withNotifyTimeout,
	NOTIFY_TIMEOUT_MS,
	STREAM_IDLE_MS
} from './bridge';
export type {
	AnswerFrame,
	BridgeOptions,
	ChannelAttachment,
	ChannelMessage,
	MessageFrame,
	ReactionFrame,
	Work,
	WorkFrame
} from './bridge';
export {
	CONNECTION_FILE,
	LINE_MAX,
	oneLine,
	readConnection,
	runMonitor,
	type Connection,
	type MonitorOptions
} from './monitor';
export {
	CLAIM_EVERY_MS,
	CLAIM_FILE,
	CLAIM_STALE_MS,
	channelIsLive,
	claimPath,
	stampClaim,
	type Claim
} from './claim';
