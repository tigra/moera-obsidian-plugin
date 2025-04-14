import {App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile} from 'obsidian';
import {MoeraNode} from "moeralib/typings/node";
import {PostingInfo, PostingSourceInfo} from "moeralib/typings/node/types";
import * as CryptoJS from 'crypto-js';

const {MoeraNode} = require('moeralib/node');
const {MoeraNaming, resolve} = require('moeralib/naming');
const util = require('util');


interface SecureTokenPluginSettings {
	encryptedToken: string | null;
	lastUnlockTime: number | null;
	autoLockDelay: number; // in milliseconds
	nodename: string;
	acceptedReactions: {
		positive: string;
		negative: string;
	}
}

const DEFAULT_SETTINGS: SecureTokenPluginSettings = {
	encryptedToken: null,
	lastUnlockTime: null,
	autoLockDelay: 1 * 60 * 60 * 1000, // 1 hours in milliseconds
	nodename: 'tigra',
	acceptedReactions: {
		positive: "+0x1f4a1,+0x1f44d,+0x1f4af,+0x1f60d,+0x1f600,+0x1f926,+0x1f62e,+0x1f622,+0x1f620,+0x1f92e,*",
		negative: "+0x1f4a1,+0x1f44d,+0x1f4af,+0x1f60d,+0x1f600,+0x1f926,+0x1f62e,+0x1f622,+0x1f620,+0x1f92e,*"
	}
}


interface MoeraPost {
	frontmatterYaml: string | null;
	frontmatterObj: Record<string, any>;
	content: string;
}

/**
 * Parses an Obsidian file and separates frontmatter from content
 * @param fileContent - The raw content of the file
 * @returns An object with frontmatterYaml, frontmatterObj, and content properties
 */
function parseObsidianFile(fileContent: string): MoeraPost {
	// Initialize the result object
	const result: MoeraPost = {
		frontmatterYaml: null,
		frontmatterObj: {},
		content: fileContent
	};

	// Check if the file has frontmatter (starts with ---)
	if (!fileContent.startsWith('---')) {
		return result; // No frontmatter, return the content as is
	}

	// Find the end of the frontmatter section
	const endOfFrontmatter = fileContent.indexOf('---', 3);
	if (endOfFrontmatter === -1) {
		return result; // No closing --- found, return content as is
	}

	// Extract the frontmatter YAML
	result.frontmatterYaml = fileContent.substring(3, endOfFrontmatter).trim();

	// Parse the YAML into an object
	try {
		// Simple parser without external dependencies:
		const obj: Record<string, any> = {};
		result.frontmatterYaml.split('\n').forEach(line => {
			// Skip empty lines
			if (!line.trim()) return;

			// Check if the line has a key-value pair
			const colonIndex = line.indexOf(':');
			if (colonIndex !== -1) {
				const key = line.substring(0, colonIndex).trim();
				const value = line.substring(colonIndex + 1).trim();
				obj[key] = value;
			}
		});
		result.frontmatterObj = obj;
	} catch (error) {
		console.error('Error parsing frontmatter YAML:', error);
	}

	// Extract the content (everything after the frontmatter)
	result.content = fileContent.substring(endOfFrontmatter + 3).trim();

	return result;
}

export default class MoeraObsidianPlugin extends Plugin {
	settings: SecureTokenPluginSettings;
	decryptedToken: string | null = null;

	private node: MoeraNode;
	private nodeUrl: string;

	async publishToMoera(file: TFile | null, content: string) {
		const activeFile = this.app.workspace.getActiveFile();
		new Notice(`Active file: ${activeFile}`);
		if (file) {
			// Get the file's metadata including front matter
			const metadata = this.app.metadataCache.getFileCache(file);

			console.log(`metadata: ${metadata}`)

			const parsedFile = parseObsidianFile(content);

			// Access the front matter
			// const frontMatter = metadata?.frontmatter;

			// Now you can work with the front matter object
			console.log(`frontmatter: ${parsedFile.frontmatterObj}`);

			if (activeFile instanceof TFile) {
				// const fileContent = await this.app.vault.read(activeFile);
				console.log(parsedFile.content);
				new Notice("Need to authenticate on a node...")
				await this.auth();


				const currentTime = Math.floor(Date.now() / 1000);

				// Access specific front matter properties
				const moeraPostId = parsedFile.frontmatterObj?.moeraPostId;
				if (moeraPostId === undefined) {
					console.log("new post");

					console.log('Creating new post with timestamp:', new Date(currentTime * 1000).toISOString());

					const postingData = this.createPostingData(parsedFile, currentTime, activeFile.basename, "timeline");

					// Create the post
					const newPost = await this.node.createPosting(postingData);

					new Notice('New post created successfully!');
					console.log('Post created successfully!');
					console.log('Post ID:', newPost.id);
					console.log('Post: ', util.inspect(newPost, {depth: 2, colors: true}));

					// Step 4: Wait briefly for the post to be processed
					console.log('Waiting for post to be processed...');
					await new Promise(resolve => setTimeout(resolve, 500));

					const updatedPosting = await this.retrievePosting(newPost.id);
					await this.updateLocalfile(activeFile, parsedFile, updatedPosting);
					new Notice("New post liked to a local file.")
				} else {
					console.log(`already posted, updating: ${moeraPostId}`);
					const currentPosting = await this.retrievePosting(moeraPostId);
					console.log("frontmatter revision id: ", parsedFile.frontmatterObj?.moeraRevisionId);
					console.log("node revision id:", currentPosting.revisionId);
					if (parsedFile.frontmatterObj
						&& 'moeraRevisionId' in parsedFile.frontmatterObj
						&& currentPosting.revisionId != parsedFile.frontmatterObj?.moeraRevisionId) {
						console.log("Updated on node");
						const postUrl = `${this.nodeUrl}/${currentPosting.id}`;
						const modal = new ConfirmationModal(this.app,
							`<p>Seems the note has already been published at 
							<a href='${postUrl}'>${postUrl}</a>, but updated on the node since.</p>
							Local revision: ${parsedFile.frontmatterObj?.moeraRevisionId} <br>
							Remote revision: ${currentPosting.revisionId}<br>
							<p>Are you sure to overwrite the post content with the current file content?</p>`,
							() => {
								new Notice("Okay, as you wish. Overwriting the post. " +
									"However the node stores an old revision internally too " +
									"(but this plugin cannot read it yet).");
								this.doUpdatePosting(activeFile, parsedFile, currentTime, moeraPostId, content);
							}
						);
						modal.open();
						// TODO Actually the update of a file on a node may happen _after_ the confirmation of an overwrite. Should we ask again in cycle? :)
					} else {
						await this.doUpdatePosting(activeFile, parsedFile, currentTime, moeraPostId, content);
					}
				}
			}
		}
	}

	private createPostingData(parsedFile: MoeraPost, currentTime: number, subject: string, feed: string | null) {
		let postData = {
			bodySrc: {
				subject: subject,
				text: parsedFile.content
			},
			bodySrcFormat: "markdown",
			createdAt: currentTime, // Set creation time
			acceptedReactions: {
				positive: "+0x1f4a1,+0x1f44d,+0x1f4af,+0x1f60d,+0x1f600,+0x1f926,+0x1f62e,+0x1f622,+0x1f620,+0x1f92e,*",
				negative: "+0x1f4a4,+0x1f44e,+0x1f4a9,+0x2694,+0x23f3,+0x1f3a9,+0x1f643,+0x1f61c,+0x1f494,+0x1f47f",
			},
			feedName: "timeline"
		};
		if (feed) {
			// Publish to timeline feed with timestamp
			postData['publications'] = [
				{
					feedName: "timeline",
					publishedAt: currentTime
				}
			]
		}
		return postData;
	}

	private async doUpdatePosting(
		activeFile: TFile, parsedFile: MoeraPost, currentTime: number, moeraPostId: string, content: string) {

		const postingData = this.createPostingData(parsedFile, currentTime, activeFile.basename, null);

		this.node.updatePosting(moeraPostId, postingData);
		new Notice("Post updated!")

		console.log('Waiting for post to be processed...');
		await new Promise(resolve => setTimeout(resolve, 500));

		const updatedPosting = await this.retrievePosting(moeraPostId);
		await this.updateLocalfile(activeFile, parsedFile, updatedPosting);
		new Notice("Local file frontmatter updated with the post properties");
	}

	private async auth() {
		const nodename = this.settings.nodename;
		const token = await this.getDecryptedToken();

		if (token) {
			console.log(`Using token: ${token.substring(0, 3)}...`);

			this.nodeUrl = await resolve(nodename);

			this.node = new MoeraNode(this.nodeUrl);
			this.node.token(token);
			this.node.authAdmin();
			return this.node;
		} else {
			new Notice("There is no token")
		}
	}

	async retrievePosting(postId: string) {
		this.auth();
		// Step 5: Retrieve and display the post
		console.log(`\nRetrieving post with ID: ${postId}`);
		const retrievedPost = await this.node.getPosting(postId);

		console.log('\nPost retrieved successfully!');
		console.log('\n--- Post Summary ---');
		console.log(`Title: ${retrievedPost.heading}`);
		console.log(`Created: ${new Date(retrievedPost.createdAt * 1000).toLocaleString()}`);
		console.log(`Owner: ${retrievedPost.ownerFullName} (${retrievedPost.ownerName})`);
		// console.log(`Content: ${retrievedPost.body.text.replace(/<[^>]*>/g, '')}`);

		console.log('\n--- Full Post Details ---');
		console.log(util.inspect(retrievedPost, {depth: 2, colors: true}));
		return retrievedPost;
	}

	async updateLocalfile(file: TFile, parsedFile: MoeraPost, posting: PostingInfo) {
		// New frontmatter values to set
		const newFrontmatterValues = {
			moeraPostId: posting.id,
			moeraRevisionId: posting.revisionId,
			moeraTotalRevisions: posting.totalRevisions,
			moeraAcceptedPositiveReactions: posting.acceptedReactions?.positive,
			moeraAcceptedNegativeReactions: posting.acceptedReactions?.positive
		};
		Object.assign(parsedFile.frontmatterObj, newFrontmatterValues);

		const newFrontmatter = Object.entries(parsedFile.frontmatterObj)
			.map(([key, value]) => `${key}: ${value}`)
			.join('\n');
		const updatedContent = `---\n${newFrontmatter}\n---\n${parsedFile.content}`;
		await this.app.vault.modify(file, updatedContent);
	}

	async onload() {
		await this.loadSettings();

		new Notice("Reloading Moera-Obsidian plugin. @@@@@@@@@");

		// Add a command to set/update the token
		this.addCommand({
			id: 'set-api-token',
			name: 'Set API Token',
			callback: () => {
				new SetTokenModal(this.app, this).open();
			}
		});


		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Moera Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		this.addCommand({
			id: 'moera-publish',
			name: 'Publish to Moera',
			callback: async () => {
				await this.publishCurrentFileToMoera();
			}
		})

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new Notice("zzzz");
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				new Notice("yyyy");
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				new Notice("xxxx");
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// Register a file menu item
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, source) => {
				// Only add menu items for markdown files
				if (file) {
					menu.addItem((item) => {
						item
							.setTitle("Publish note to Moera")
							.setIcon("upload-cloud")
							.onClick(async () => {
								// What happens when the menu item is clicked
								// For example:
								console.log("File selected:", file.path);

								// You can read the file contents
								// const content = await this.app.vault.read(file);

								// Perform some action with the file
								new Notice(`Processing ${file.name}...`);

								// Example: Do something with the file
								this.publishCurrentFileToMoera();
							});
					});

					// Add a separator
					menu.addSeparator();

				}
			})
		);

		// Add settings tab
		this.addSettingTab(new MoeraObsidianPluginSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// Register an editor menu item
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				// Add your custom menu item
				menu.addItem((item) => {
					item
						.setTitle("Publish note to Moera")
						.setIcon("star")
						.onClick(() => {
							this.publishCurrentFileToMoera();
						});
				});
				menu.addSeparator();
				// Conditionally add menu items based on selection or other criteria
				const selection = editor.getSelection();
				if (selection) {
					menu.addItem((item) => {
						item
							.setTitle("Do Something with Selection")
							.setIcon("text")
							.onClick(() => {
								// Action for selected text
							});
					});
				}
			})
		);

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
		new Notice("...reloaded.")
	}

	private async publishCurrentFileToMoera() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active file to publish!');
			return;
		}
		const fileContent = await this.app.vault.read(activeFile);
		await this.publishToMoera(activeFile, fileContent);
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Attempts to get the decrypted token, prompting for password if needed
	 */
	async getDecryptedToken(): Promise<string | null> {
		// Check if we have a decrypted token and it hasn't expired
		console.log("Obtaining decrypted token...")
		const now = Date.now();
		if (
			this.decryptedToken &&
			this.settings.lastUnlockTime &&
			(now - this.settings.lastUnlockTime) < this.settings.autoLockDelay
		) {
			return this.decryptedToken;
		}

		// If we don't have an encrypted token, we need to set one first
		if (!this.settings.encryptedToken) {
			new Notice('No API token set. Please set a token first.');

			// Create a promise to handle the token setup sequence
			return new Promise((resolve) => {
				const tokenModal = new SetTokenModal(this.app, this);

				// Add an onClose callback to the SetTokenModal
				tokenModal.onClose = () => {
					// Check if a token was successfully set
					if (this.settings.encryptedToken && this.decryptedToken) {
						resolve(this.decryptedToken);
					} else {
						resolve(null);
					}
				};

				tokenModal.open();
			});
		}

		// We need to decrypt an existing token
		return new Promise((resolve) => {
			new PasswordModal(this.app, this, (success) => {
				resolve(success ? this.decryptedToken : null);
			}).open();
		});
	}

	/**
	 * Encrypts and saves a token
	 */
	async encryptAndSaveToken(token: string, password: string): Promise<void> {
		this.settings.encryptedToken = CryptoJS.AES.encrypt(token, password).toString();
		this.decryptedToken = token;
		this.settings.lastUnlockTime = Date.now();
		await this.saveSettings();
	}

	/**
	 * Attempts to decrypt the stored token
	 */
	decryptToken(password: string): boolean {
		try {
			if (!this.settings.encryptedToken) return false;

			const decrypted = CryptoJS.AES.decrypt(this.settings.encryptedToken, password);
			const decryptedString = decrypted.toString(CryptoJS.enc.Utf8);

			if (!decryptedString) return false;

			this.decryptedToken = decryptedString;
			this.settings.lastUnlockTime = Date.now();
			this.saveSettings();
			return true;
		} catch (e) {
			console.error("Failed to decrypt token", e);
			return false;
		}
	}

	/**
	 * Locks the token (clears the decrypted version)
	 */
	lockToken(): void {
		this.decryptedToken = null;
		this.settings.lastUnlockTime = null;
		this.saveSettings();
		new Notice("Token locked");
	}
}

// Create a confirmation modal class
class ConfirmationModal extends Modal {
	message = 'Are you sure?';
	onConfirm = () => {
	};

	constructor(app, message: string, onConfirm) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const {contentEl} = this;

		// Add a title to the modal
		contentEl.createEl('h2', {text: 'Confirmation'});

		// Create a container for the HTML content
		const htmlContainer = contentEl.createDiv('html-content-container');

		// Set the HTML content
		htmlContainer.innerHTML = this.message;

		// Add some styling to the container if needed
		htmlContainer.style.margin = '10px 0';
		htmlContainer.style.padding = '10px';
		htmlContainer.style.maxHeight = '300px';
		htmlContainer.style.overflow = 'auto';

		// Add buttons
		new Setting(contentEl)
			.addButton(btn => {
				btn.setButtonText('Cancel')
					.setCta()
					.onClick(() => {
						this.close();
					});
			})
			.addButton(btn => {
				btn.setButtonText('Confirm')
					.setCta()
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					});
			});
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

// // Usage example (in your plugin's code)
// function showConfirmationDialog(message, actionCallback) {
// 	const modal = new ConfirmationModal(this.app, message, actionCallback);
// 	modal.open();
// }
//
// // Example of how to use it in your plugin
// // Inside your plugin's command handler:
// this.addCommand({
// 	id: 'my-risky-command',
// 	name: 'Perform Risky Action',
// 	callback: () => {
// 		// Show confirmation dialog
// 		showConfirmationDialog(
// 			'Are you sure you want to proceed with this action?',
// 			() => {
// 				// This function will be called only if the user confirms
// 				console.log('User confirmed the action');
// 				// Perform the actual action here
// 				this.performRiskyAction();
// 			}
// 		);
// 	}
// });

// The actual action function
function performRiskyAction() {
	// Implement your risky action here
	console.log('Performing risky action...');
	// Example: Delete a file, modify content, etc.
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}


/**
 * Modal for entering the password to decrypt the token
 */
class PasswordModal extends Modal {
	plugin: MoeraObsidianPlugin;
	password: string = "";
	onResult: (success: boolean) => void;
	passwordInputEl: HTMLInputElement;

	constructor(app: App, plugin: MoeraObsidianPlugin, onResult: (success: boolean) => void) {
		super(app);
		this.plugin = plugin;
		this.onResult = onResult;
	}

	onOpen() {
		const {contentEl} = this;

		contentEl.createEl("h2", {text: "Enter your password"});
		contentEl.createEl("p", {text: "Please enter the password to unlock your API token."});

		// Create the password input
		new Setting(contentEl)
			.setName("Password")
			.addText(text => {
				this.passwordInputEl = text
					.setPlaceholder("Enter your password")
					.setValue("")
					.onChange(value => {
						this.password = value;
					})
					.inputEl;

				// Set input type to password
				this.passwordInputEl.type = "password";

				// Add keydown event listener for Enter key
				this.passwordInputEl.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.attemptUnlock();
					} else if (e.key === "Escape") {
						new Notice("Cancelled!");
					}
				});

				// Focus the input field when the modal opens
				setTimeout(() => {
					this.passwordInputEl.focus();
				}, 10);

				return text;
			});

		// Add buttons using separate settings for better layout control
		const buttonSetting = new Setting(contentEl);

		// Add Cancel button
		buttonSetting.addButton(btn =>
			btn.setButtonText("Cancel")
				.setCta()
				.onClick(() => {
					// new Notice("Cancelled!");
					// this.onResult(false);
					this.onResult(false);
					this.close();
				})
		);

		// Add Unlock button
		buttonSetting.addButton(btn =>
			btn.setButtonText("Unlock")
				.setCta()
				.onClick(() => {
					this.attemptUnlock();
				})
		);
	}

	// Helper method to attempt unlocking with current password
	attemptUnlock() {
		const success = this.plugin.decryptToken(this.password);
		if (success) {
			new Notice("Token unlocked successfully");
			this.onResult(true);
			this.close();
		} else {
			new Notice("Incorrect password");
			// Keep focus on the password field for retry
			this.passwordInputEl.focus();
		}
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

/**
 * Modal for setting or updating the token
 */
class SetTokenModal extends Modal {
	plugin: MoeraObsidianPlugin;
	token: string = "";
	password: string = "";
	confirmPassword: string = "";

	constructor(app: App, plugin: MoeraObsidianPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const {contentEl} = this;

		contentEl.createEl("h2", {text: "Set API Token"});
		contentEl.createEl("p", {text: "Enter your API token and a password to encrypt it."});

		new Setting(contentEl)
			.setName("API Token")
			.addText(text => text
				.setPlaceholder("Enter your API token")
				.setValue("")
				.onChange(value => {
					this.token = value;
				})
			);

		new Setting(contentEl)
			.setName("Encryption Password")
			.addText(text => text
				.setPlaceholder("Enter a strong password")
				.setValue("")
				.onChange(value => {
					this.password = value;
				})
				.inputEl.type = "password"
			);

		new Setting(contentEl)
			.setName("Confirm Password")
			.addText(text => text
				.setPlaceholder("Confirm your password")
				.setValue("")
				.onChange(value => {
					this.confirmPassword = value;
				})
				.inputEl.type = "password"
			);

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText("Cancel")
				.setCta()
				.onClick(() => {
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText("Save")
				.setCta()
				.onClick(async () => {
					if (!this.token) {
						new Notice("Please enter an API token");
						return;
					}
					if (!this.password) {
						new Notice("Please enter a password");
						return;
					}
					if (this.password !== this.confirmPassword) {
						new Notice("Passwords do not match");
						return;
					}

					await this.plugin.encryptAndSaveToken(this.token, this.password);
					new Notice("API token saved and encrypted");
					this.close();
				}));
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

/**
 * Settings tab for configuring plugin options
 */
class MoeraObsidianPluginSettingTab extends PluginSettingTab {
	plugin: MoeraObsidianPlugin;

	constructor(app: App, plugin: MoeraObsidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: 'Secure Token Settings'});

		new Setting(containerEl)
			.setName('Auto-lock delay')
			.setDesc('Time in hours before the token is automatically locked')
			.addSlider(slider => slider
				.setLimits(1, 24, 1)
				.setValue(this.plugin.settings.autoLockDelay / (1000 * 60 * 60))
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.autoLockDelay = value * 1000 * 60 * 60;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Token Status')
			.setDesc('Status of your encrypted API token')
			.addButton(button => button
				.setButtonText(this.plugin.settings.encryptedToken ? 'Token is set' : 'No token set')
				.setDisabled(true)
			);

		if (this.plugin.settings.encryptedToken) {
			new Setting(containerEl)
				.setName('Lock token now')
				.setDesc('Clear the decrypted token from memory')
				.addButton(button => button
					.setButtonText('Lock')
					.setCta()
					.onClick(() => {
						this.plugin.lockToken();
						this.display(); // Refresh the settings view
					})
				);

			new Setting(containerEl)
				.setName('Reset token')
				.setDesc('Remove the stored token completely')
				.addButton(button => button
					.setButtonText('Reset')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.encryptedToken = null;
						this.plugin.settings.lastUnlockTime = null;
						this.plugin.decryptedToken = null;
						await this.plugin.saveSettings();
						new Notice('Token has been reset');
						this.display(); // Refresh the settings view
					})
				);
		}
	}
}
