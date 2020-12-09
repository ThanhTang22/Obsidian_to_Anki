import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian'
import { NOTE } from './src/interfaces/note'
import { basename } from 'path'
import { Converter } from 'showdown'

/* Declaring initial variables*/

let converter = new Converter();

let MEDIA: Record<string, string> = {};

let ID_PREFIX: string = "ID: ";
let TAG_PREFIX: string = "Tags: ";
let TAG_SEP: string = " ";

let NOTE_DICT_TEMPLATE: NOTE = {
	deckName: "",
	modelName: "",
	fields: {},
	options: {
		allowDuplicate: false,
		duplicateScope: "deck",
	},
	tags: ["Obsidian_to_Anki"],
	audio: [],
};

let CONFIG_DATA = {}

const ANKI_PORT: number = 8765

const ANKI_CLOZE_REGEXP: RegExp = /{{c\d+::[\s\S]+?}}/g

function has_clozes(text: string): boolean {
	/*Checks whether text actually has cloze deletions.*/
	return ANKI_CLOZE_REGEXP.test(text)
}

function note_has_clozes(note: NOTE): boolean {
	/*Checks whether a note has cloze deletions in any of its fields.*/
	return Array(note.fields.values).some(has_clozes)
}

function string_insert(text: string, position_inserts: Array<[number, string]>): string {
	/*Insert strings in position_inserts into text, at indices.

    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")]*/
	let offset = 0
	let sorted_inserts: Array<[number, string]> = position_inserts.sort((a, b):number => a[0] - b[0])
	for (let insertion of sorted_inserts) {
		let position = insertion[0]
		let insert_str = insertion[1]
		text = text.slice(0, position + offset) + insert_str + text.slice(position + offset)
		offset += insert_str.length
	}
	return text
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
	/*Return a list of span-tuples for matches of pattern in text.*/
	let output: Array<[number, number]> = []
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		output.push(
			[match.index, match.index + match.length]
		)
	}
	return output
}

function contained_in(span: [number, number], spans: Array<[number, number]>): boolean {
	/*Return whether span is contained in spans (+- 1 leeway)*/
	return spans.some(
		(element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1
	)
}

function* findignore(pattern: RegExp, text: string, ignore_spans: Array<[number, number]>): IterableIterator<RegExpMatchArray> {
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		if (!(contained_in([match.index, match.index + match.length], ignore_spans))) {
			yield match
		}
	}
}

interface AnkiConnectRequest {
	action: string,
	params: any,
	version: number
}

class AnkiConnect {
	static request(action: string, params={}) {
		return {action, version:6, params}
	}

	static invoke(action: string, params={}) {
	    return new Promise((resolve, reject) => {
	        const xhr = new XMLHttpRequest()
	        xhr.addEventListener('error', () => reject('failed to issue request'));
	        xhr.addEventListener('load', () => {
	            try {
	                const response = JSON.parse(xhr.responseText);
	                if (Object.getOwnPropertyNames(response).length != 2) {
	                    throw 'response has an unexpected number of fields';
	                }
	                if (!response.hasOwnProperty('error')) {
	                    throw 'response is missing required error field';
	                }
	                if (!response.hasOwnProperty('result')) {
	                    throw 'response is missing required result field';
	                }
	                if (response.error) {
	                    throw response.error;
	                }
	                resolve(response.result);
	            } catch (e) {
	                reject(e);
	            }
	        });

	        xhr.open('POST', 'http://127.0.0.1:8765');
	        xhr.send(JSON.stringify({action, version: 6, params}));
	    });
	}
}

interface PluginSettings {
	CUSTOM_REGEXPS: Record<string, string>,
	Syntax: {
		"Begin Note": string,
		"End Note": string,
		"Begin Inline Note": string,
		"End Inline Note": string,
		"Target Deck Line": string,
		"File Tags Line": string,
		"Delete Regex Note Line": string,
		"Frozen Fields Line": string
	},
	Defaults: {
		"Add File Link": boolean,
		"Tag": string,
		"Deck": string,
		"CurlyCloze": boolean,
		"Regex": boolean,
		"ID Comments": boolean,
	}
}

let test = `This is a big paragraph
WeEee
EWweqwe
EWewqqewqw
`

console.log(converter.makeHtml(test))

export default class MyPlugin extends Plugin {

	settings: PluginSettings
	note_types: Array<string>

	async own_saveData(data_key: string, data: any) {
		let current_data = await this.loadData()
		current_data[data_key] = data
		this.saveData(current_data)
	}

	async getDefaultSettings() {
		let settings: PluginSettings = {
			CUSTOM_REGEXPS: {},
			Syntax: {
				"Begin Note": "START",
				"End Note": "END",
				"Begin Inline Note": "STARTI",
				"End Inline Note": "ENDI",
				"Target Deck Line": "TARGET DECK",
				"File Tags Line": "FILE TAGS",
				"Delete Regex Note Line": "DELETE",
				"Frozen Fields Line": "FROZEN"
			},
			Defaults: {
				"Add File Link": false,
				"Tag": "Obsidian_to_Anki",
				"Deck": "Default",
				"CurlyCloze": false,
				"Regex": false,
				"ID Comments": true,
			}
		}
		/*Making settings from scratch, so need note types*/
		for (let note_type of await AnkiConnect.invoke('modelNames') as Array<string>) {
			settings["CUSTOM_REGEXPS"][note_type] = ""
		}
		return settings
	}

	async loadSettings() {
		let current_data = await this.loadData()
		if (current_data == null) {
			const default_sets = await this.getDefaultSettings()
			this.saveData(
				{
					settings: default_sets,
					"Added Media": [],
					"File Hashes": {}
				}
			)
			return default_sets
		} else {
			return current_data.settings
		}
	}

	async saveSettings() {
		this.saveData(
				{
					settings: this.settings,
					"Added Media": [],
					"File Hashes": {}
				}
		)
	}

	regenerateSettingsRegexps() {
		let regexp_section = this.settings["CUSTOM_REGEXPS"]
		// For new note types
		for (let note_type of this.note_types) {
			this.settings["CUSTOM_REGEXPS"][note_type] = regexp_section.hasOwnProperty(note_type) ? regexp_section[note_type] : ""
		}
		// Removing old note types
		for (let note_type of Object.keys(this.settings["CUSTOM_REGEXPS"])) {
			if (!this.note_types.includes(note_type)) {
				delete this.settings["CUSTOM_REGEXPS"][note_type]
			}
		}
	}

	async onload() {
		console.log('loading Obsidian_to_Anki...');

		this.settings = await this.loadSettings()
		this.note_types = Object.keys(this.settings["CUSTOM_REGEXPS"])

		this.addRibbonIcon('dice', 'Sample Plugin', () => {
			new Notice('This is a notice!');
		});

		this.addStatusBarItem().setText('Status Bar Text');

		this.addCommand({
			id: 'open-sample-modal',
			name: 'Open Sample Modal',
			// callback: () => {
			// 	console.log('Simple Callback');
			// },
			checkCallback: (checking: boolean) => {
				let leaf = this.app.workspace.activeLeaf;
				if (leaf) {
					if (!checking) {
						new SampleModal(this.app).open();
					}
					return true;
				}
				return false;
			}
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.registerEvent(this.app.on('codemirror', (cm: CodeMirror.Editor) => {
			console.log('codemirror', cm);
		}));

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	async onunload() {
		console.log("Saving settings for Obsidian_to_Anki...")
		this.saveSettings()
		console.log('unloading Obsidian_to_Anki...');
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		let {contentEl} = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {

	setup_table() {
		let {containerEl} = this;
		const plugin = (this as any).plugin
		containerEl.createEl('h3', {text: 'Note type settings'})
		let note_type_table = containerEl.createEl('table', {cls: "anki-settings-table"})
		let head = note_type_table.createTHead()
		let header_row = head.insertRow()
		for (let header of ["Note Type", "Custom Regexp"]) {
			let th = document.createElement("th")
			th.appendChild(document.createTextNode(header))
			header_row.appendChild(th)
		}
		let main_body = note_type_table.createTBody()
		for (let note_type of plugin.note_types) {
			let row = main_body.insertRow()
			row.insertCell()
			row.insertCell()
			let row_cells = row.children
			row_cells[0].innerHTML = note_type
			let regexp_section = plugin.settings["CUSTOM_REGEXPS"]
			let custom_regexp = new Setting(row_cells[1] as HTMLElement)
				.addText(
						text => text.setValue(
						regexp_section.hasOwnProperty(note_type) ? regexp_section[note_type] : ""
						)
						.onChange((value) => {
							plugin.settings["CUSTOM_REGEXPS"][note_type] = value
							plugin.saveSettings()
						})
				)
			custom_regexp.settingEl = row_cells[1] as HTMLElement
			custom_regexp.infoEl.remove()
			custom_regexp.controlEl.className += " anki-center"
		}
	}

	setup_syntax() {
		let {containerEl} = this;
		const plugin = (this as any).plugin
		let syntax_settings = containerEl.createEl('h3', {text: 'Syntax Settings'})
		for (let key of Object.keys(plugin.settings["Syntax"])) {
			new Setting(syntax_settings)
				.setName(key)
				.addText(
						text => text.setValue(plugin.settings["Syntax"][key])
						.onChange((value) => {
							plugin.settings["Syntax"][key] = value
							plugin.saveSettings()
						})
				)
		}
	}

	setup_defaults() {
		let {containerEl} = this;
		const plugin = (this as any).plugin
		let defaults_settings = containerEl.createEl('h3', {text: 'Defaults'})
		for (let key of Object.keys(plugin.settings["Defaults"])) {
			if (typeof plugin.settings["Defaults"][key] === "string") {
				new Setting(defaults_settings)
					.setName(key)
					.addText(
						text => text.setValue(plugin.settings["Defaults"][key])
						.onChange((value) => {
							plugin.settings["Defaults"][key] = value
							plugin.saveSettings()
						})
				)
			} else {
				new Setting(defaults_settings)
					.setName(key)
					.addToggle(
						toggle => toggle.setValue(plugin.settings["Defaults"][key])
						.onChange((value) => {
							plugin.settings["Defaults"][key] = value
							plugin.saveSettings()
						})
					)
			}
		}
	}

	setup_buttons() {
		let {containerEl} = this
		const plugin = (this as any).plugin
		let action_buttons = containerEl.createEl('h3', {text: 'Actions'})
		new Setting(action_buttons)
			.setName("Regenerate Table")
			.setDesc("Connect to Anki to regenerate the table with new note types, or get rid of deleted note types.")
			.addButton(
				button => {
					button.setButtonText("Regenerate")
					.onClick(async () => {
						plugin.note_types = await AnkiConnect.invoke('modelNames')
						plugin.regenerateSettingsRegexps()
						plugin.saveSettings()
						this.setup_display()
					})
				}
			)
	}

	setup_display() {
		let {containerEl} = this

		containerEl.empty()
		containerEl.createEl('h2', {text: 'Obsidian_to_Anki settings'})
		this.setup_table()
		this.setup_syntax()
		this.setup_defaults()
		this.setup_buttons()
	}

	async display() {
		this.setup_display()
	}
}