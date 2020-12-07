const vscode = require('vscode');
const fs = require('fs-extra');
const path = require('path');
const klaw = require('klaw');
const matter = require('gray-matter');
const {resolveHome} = require('./utils');

class VSNotesTreeView  {
  constructor () {
    const config = vscode.workspace.getConfiguration('vsnotes');
    this.baseDir = resolveHome(config.get('defaultNotePath'));
    this.ignorePattern = new RegExp(config.get('ignorePatterns')
      .map(function (pattern) {return '(' + pattern + ')'})
      .join('|'));
    this.hideTags = config.get('treeviewHideTags');
    this.hideFiles = config.get('treeviewHideFiles');
    this.tagSplitter = config.get('tagSplitter');

    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh () {
    this._onDidChangeTreeData.fire();
  }

  getChildren (node) {
    if (node) {
      switch (node.type) {
        case 'rootTag':
          this.tags = Promise.resolve(this._getTags(this.baseDir))
          return this.tags;
        case 'tag':
          return node.nodes;
        case 'rootFile':
          return Promise.resolve(this._getDirectoryContents(this.baseDir));
        case 'file':
          return Promise.resolve(this._getDirectoryContents(node.path));
      }
    } else {
      const treeview = [];
      if (!this.hideFiles) {
        treeview.push({
          type: 'rootFile'
        });
      }
      if (!this.hideTags) {
        treeview.push({
          type: 'rootTag'
        });
      }
      return treeview;
    }
  }

  getTreeItem (node) {
    switch (node.type) {
      case 'rootTag':
        let rootTagTreeItem = new vscode.TreeItem('Tags', vscode.TreeItemCollapsibleState.Expanded);
        rootTagTreeItem.iconPath = {
          light: path.join(__filename, '..', '..', 'media', 'light', 'tag.svg'),
          dark: path.join(__filename, '..', '..', 'media', 'dark', 'tag.svg')
        };
        return rootTagTreeItem;
      case 'rootFile':
        let rootFileTreeItem = new vscode.TreeItem('Files', vscode.TreeItemCollapsibleState.Expanded);
        rootFileTreeItem.iconPath = {
          light: path.join(__filename, '..', '..', 'media', 'light', 'file-directory.svg'),
          dark: path.join(__filename, '..', '..', 'media', 'dark', 'file-directory.svg')
        };
        return rootFileTreeItem;
      case 'tag':
        let tagTreeItem = new vscode.TreeItem(node.tag, vscode.TreeItemCollapsibleState.Collapsed);
        tagTreeItem.iconPath = {
          light: path.join(__filename, '..', '..', 'media', 'light', 'tag.svg'),
          dark: path.join(__filename, '..', '..', 'media', 'dark', 'tag.svg')
        };
        return tagTreeItem;
      case 'file':
        const isDir = node.stats.isDirectory()
        const state = isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        let fileTreeItem = new vscode.TreeItem(node.file, state)
        if (isDir) {
          fileTreeItem.iconPath = {
            light: path.join(__filename, '..', '..', 'media', 'light', 'file-directory.svg'),
            dark: path.join(__filename, '..', '..', 'media', 'dark', 'file-directory.svg')
          };
        } else {
          fileTreeItem.command = {
            command: 'vscode.open',
            title: '',
            arguments: [vscode.Uri.file(node.path)]
          }
          fileTreeItem.iconPath = {
            light: path.join(__filename, '..', '..', 'media', 'light', 'file.svg'),
            dark: path.join(__filename, '..', '..', 'media', 'dark', 'file.svg')
          };
        }
        return fileTreeItem;
    }
  }

  // Given a filepath, return an array of TreeItems
  _getDirectoryContents (filePath) {
    return new Promise ((resolve, reject) => {
      fs.readdir(filePath).then(files => {
        let items = [];
        files.forEach(file => {
          if (!this.ignorePattern.test(file)) {
            items.push({
              type: 'file',
              file: file,
              path: path.join(filePath, file),
              stats: fs.statSync(path.join(filePath, file))
            });
          }
        });
        resolve(items);
      }).catch(err => {
        reject(err);
      })
    })
  }

  _getTags () {
    return new Promise((resolve, reject) => {
      let files = [];

      klaw(this.baseDir)
        .on('data', item => {
          files.push(new Promise((res, rej) => {
            const fileName = path.basename(item.path);
            if (!item.stats.isDirectory() && !this.ignorePattern.test(fileName)) {
              fs.readFile(item.path).then(contents => {
                res({
                  path: item.path,
                  contents: contents,
                  payload: {
                    type: 'file',
                    file: fileName,
                    path: item.path,
                    stats: item.stats
                  }
                });
              }).catch(err => {
                console.error(err);
                res();
              })
            } else {
              res();
            }
          }))
        })
        .on('error', (err, item) => {
          reject(err)
          console.error('Error while walking notes folder for tags: ', item, err);
        })
        .on('end', () => {
          Promise.all(files).then(files => {

            // Build a tag index first
            const pushTag = function(words, index, tags, filePayload) {
              const w = words[index];
              let node = tags.find(obj=>(obj.tag === w));
              if (!node) {
                tags.push({
                  type: 'tag', 
                  tag: w, 
                  nodes: []
                });
                node = tags[tags.length - 1];
              }
              if (index < words.length - 1) {
                pushTag(words, index + 1, node.nodes, filePayload);
              } else {
                node.nodes.push(filePayload);
              }
            };
            const sortFunc = function(a,b) {
              if (a.type != b.type) {
                return (a.type < b.type)? +1: -1;
              } else {
                if (a.type === 'tag') {
                  return (a.tag === b.tag) ? 0: ((a.tag > b.tag) ? +1 : -1);
                } else if (a.type === 'file')  {
                  return (a.file === b.file) ? 0 : ((a.file > b.file) ? +1 : -1);
                } else {
                  return 0;
                }
              }
            };
            const sortTags = function(tags) {
              tags.sort(sortFunc);
              for (const obj of tags) { 
                if (obj.type === 'tag') {
                  sortTags(obj.nodes)
                }
              }
            };
            let tagsRoot = [];
            for (let i = 0; i < files.length; i++) {
              if (files[i] != null && files[i]) {
                const parsedFrontMatter = this._parseFrontMatter(files[i]);
                if (parsedFrontMatter && 'tags' in parsedFrontMatter.data && parsedFrontMatter.data.tags) {
                  for (let tag of parsedFrontMatter.data.tags) {
                    const words = this.tagSplitter? tag.split(this.tagSplitter): [tag];
                    pushTag(words, 0, tagsRoot, files[i].payload);
                  }
                }
              }
            }
            sortTags(tagsRoot);
            resolve(tagsRoot);
          }).catch(err => {
            console.error(err)
          })
        })
    });
  }

  _parseFrontMatter (file) {
    try {
      const parsedFrontMatter = matter(file.contents)
      if (!(parsedFrontMatter.data instanceof Object)) {
        console.error('YAML front-matter is not an object: ', file.path);
        return null;
      }
      return parsedFrontMatter;
    } catch (e) {
      console.error(file.path, e);
      return null;
    }
  }
}

module.exports = VSNotesTreeView;
