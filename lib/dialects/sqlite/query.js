'use strict';

const _ = require('lodash');
const Utils = require('../../utils');
const debug = Utils.getLogger().debugContext('sql:sqlite');
const Promise = require('../../promise');
const AbstractQuery = require('../abstract/query');
const QueryTypes = require('../../query-types');
const sequelizeErrors = require('../../errors.js');
const parserStore = require('../parserStore')('sqlite');

class Query extends AbstractQuery {

  constructor(database, sequelize, options) {
    super();
    this.database = database;
    this.sequelize = sequelize;
    this.instance = options.instance;
    this.model = options.model;
    this.options = _.extend({
      logging: console.log,
      plain: false,
      raw: false
    }, options || {});

    this.checkLoggingOption();
  }

  getInsertIdField() {
    return 'lastID';
  }

  /**
   * rewrite query with parameters
   */
  static formatBindParameters(sql, values, dialect) {
    let bindParam;
    if (Array.isArray(values)) {
      bindParam = {};
      values.forEach((v, i) => {
        bindParam['$'+(i+1)] = v;
      });
      sql = AbstractQuery.formatBindParameters(sql, values, dialect, { skipValueReplace: true })[0];
    } else {
      bindParam = {};
      if (typeof values === 'object') {
        for (const k of Object.keys(values)) {
          bindParam['$'+k] = values[k];
        }
      }
      sql = AbstractQuery.formatBindParameters(sql, values, dialect, { skipValueReplace: true })[0];
    }
    return [sql, bindParam];
  }

  _collectModels(include, prefix) {
    const ret = {};

    if (include) {
      for (const _include of include) {
        let key;
        if (!prefix) {
          key = _include.as;
        } else {
          key = prefix + '.' + _include.as;
        }
        ret[key] = _include.model;

        if (_include.include) {
          _.merge(ret, this._collectModels(_include.include, key));
        }
      }
    }

    return ret;
  }

  run(sql, parameters) {
    this.sql = sql;
    const method = this.getDatabaseMethod();
    if (method === 'exec') {
      // exec does not support bind parameter
      sql = AbstractQuery.formatBindParameters(sql, this.options.bind, this.options.dialect, { skipUnescape: true })[0];
      this.sql = sql;
    }

    //do we need benchmark for this query execution
    const benchmark = this.sequelize.options.benchmark || this.options.benchmark;

    let queryBegin;
    if (benchmark) {
      queryBegin = Date.now();
    } else {
      this.sequelize.log('Executing (' + (this.database.uuid || 'default') + '): ' + this.sql, this.options);
    }

    debug(`executing(${this.database.uuid || 'default'}) : ${this.sql}`);

    return new Promise(resolve => {
      const columnTypes = {};
      this.database.serialize(() => {
        const executeSql = () => {
          if (this.sql.indexOf('-- ') === 0) {
            return resolve();
          } else {
            resolve(new Promise((resolve, reject) => {
              const query = this;
              // cannot use arrow function here because the function is bound to the statement
              function afterExecute(err, results) {
                /* jshint validthis:true */

                debug(`executed(${query.database.uuid || 'default'}) : ${query.sql}`);

                if (benchmark) {
                  query.sequelize.log('Executed (' + (query.database.uuid || 'default') + '): ' + query.sql, (Date.now() - queryBegin), query.options);
                }

                if (err) {
                  err.sql = query.sql;
                  reject(query.formatError(err));
                } else {
                  const metaData = this;
                  let result = query.instance;

                  // add the inserted row id to the instance
                  if (query.isInsertQuery(results, metaData)) {
                    query.handleInsertQuery(results, metaData);

                    if (!query.instance) {
                      result = metaData[query.getInsertIdField()];
                    }
                  }

                  if (query.sql.indexOf('sqlite_master') !== -1) {
                    result = results.map(resultSet => resultSet.name);
                  } else if (query.isSelectQuery()) {
                    if (!query.options.raw) {
                      // This is a map of prefix strings to models, e.g. user.projects -> Project model
                      const prefixes = query._collectModels(query.options.include);

                      results = results.map(result => {
                        return _.mapValues(result, (value, name) => {
                          let model;
                          if (name.indexOf('.') !== -1) {
                            const lastind = name.lastIndexOf('.');

                            model = prefixes[name.substr(0, lastind)];

                            name = name.substr(lastind + 1);
                          } else {
                            model = query.options.model;
                          }

                          const tableName = model.getTableName().toString().replace(/`/g, '');
                          const tableTypes = columnTypes[tableName] || {};

                          if (tableTypes && !(name in tableTypes)) {
                            // The column is aliased
                            _.forOwn(model.rawAttributes, (attribute, key) => {
                              if (name === key && attribute.field) {
                                name = attribute.field;
                                return false;
                              }
                            });
                          }

                          let type = tableTypes[name];
                          if (type) {
                            if (type.indexOf('(') !== -1) {
                              // Remove the lenght part
                              type = type.substr(0, type.indexOf('('));
                            }
                            type = type.replace('UNSIGNED', '').replace('ZEROFILL', '');
                            type = type.trim().toUpperCase();
                            const parse = parserStore.get(type);

                            if (value !== null && parse) {
                              return parse(value, { timezone: query.sequelize.options.timezone});
                            }
                          }
                          return value;
                        });
                      });
                    }

                    result = query.handleSelectQuery(results);
                  } else if (query.isShowOrDescribeQuery()) {
                    result = results;
                  } else if (query.sql.indexOf('PRAGMA INDEX_LIST') !== -1) {
                    result = query.handleShowIndexesQuery(results);
                  } else if (query.sql.indexOf('PRAGMA INDEX_INFO') !== -1) {
                    result = results;
                  } else if (query.sql.indexOf('PRAGMA TABLE_INFO') !== -1) {
                    // this is the sqlite way of getting the metadata of a table
                    result = {};

                    let defaultValue;
                    for (const _result of results) {
                      if (_result.dflt_value === null) {
                        // Column schema omits any "DEFAULT ..."
                        defaultValue = undefined;
                      } else if (_result.dflt_value === 'NULL') {
                        // Column schema is a "DEFAULT NULL"
                        defaultValue = null;
                      } else {
                        defaultValue = _result.dflt_value;
                      }

                      result[_result.name] = {
                        type: _result.type,
                        allowNull: (_result.notnull === 0),
                        defaultValue,
                        primaryKey : (_result.pk === 1)
                      };

                      if (result[_result.name].type === 'TINYINT(1)') {
                        result[_result.name].defaultValue = { '0': false, '1': true }[result[_result.name].defaultValue];
                      }

                      if (typeof result[_result.name].defaultValue === 'string') {
                        result[_result.name].defaultValue = result[_result.name].defaultValue.replace(/'/g, '');
                      }
                    }
                  } else if (query.sql.indexOf('PRAGMA foreign_keys;') !== -1) {
                    result = results[0];
                  } else if (query.sql.indexOf('PRAGMA foreign_keys') !== -1) {
                    result = results;
                  } else if (query.sql.indexOf('PRAGMA foreign_key_list') !== -1) {
                    result = results;
                  } else if ([QueryTypes.BULKUPDATE, QueryTypes.BULKDELETE].indexOf(query.options.type) !== -1) {
                    result = metaData.changes;
                  } else if (query.options.type === QueryTypes.UPSERT) {
                    result = undefined;
                  } else if (query.options.type === QueryTypes.VERSION) {
                    result = results[0].version;
                  } else if (query.options.type === QueryTypes.RAW) {
                    result = [results, metaData];
                  }

                  resolve(result);
                }
              }

              if (method === 'exec') {
                // exec does not support bind parameter
                this.database[method](this.sql, afterExecute);
              } else {
                if (!parameters) parameters = [];
                this.database[method](this.sql, parameters, afterExecute);
              }
            }));
            return null;
          }
        };

        if ((this.getDatabaseMethod() === 'all')) {
          let tableNames = [];
          if (this.options && this.options.tableNames) {
            tableNames = this.options.tableNames;
          } else if (/FROM `(.*?)`/i.exec(this.sql)) {
            tableNames.push(/FROM `(.*?)`/i.exec(this.sql)[1]);
          }

          // If we already have the metadata for the table, there's no need to ask for it again
          tableNames = _.filter(tableNames, tableName => !(tableName in columnTypes) && tableName !== 'sqlite_master');

          if (!tableNames.length) {
            return executeSql();
          } else {
            return Promise.map(tableNames, tableName =>
              new Promise(resolve => {
                tableName = tableName.replace(/`/g, '');
                columnTypes[tableName] = {};

                this.database.all('PRAGMA table_info(`' + tableName + '`)', (err, results) => {
                  if (!err) {
                    for (const result of results) {
                      columnTypes[tableName][result.name] = result.type;
                    }
                  }
                  resolve();
                });
              })
            ).then(executeSql);
          }
        } else {
          return executeSql();
        }
      });
    });
  }

  formatError(err) {

    switch (err.code) {
      case 'SQLITE_CONSTRAINT': {
        let match = err.message.match(/FOREIGN KEY constraint failed/);
        if (match !== null) {
          return new sequelizeErrors.ForeignKeyConstraintError({
            parent :err
          });
        }

        let fields = [];

        // Sqlite pre 2.2 behavior - Error: SQLITE_CONSTRAINT: columns x, y are not unique
        match = err.message.match(/columns (.*?) are/);
        if (match !== null && match.length >= 2) {
          fields = match[1].split(', ');
        } else {

          // Sqlite post 2.2 behavior - Error: SQLITE_CONSTRAINT: UNIQUE constraint failed: table.x, table.y
          match = err.message.match(/UNIQUE constraint failed: (.*)/);
          if (match !== null && match.length >= 2) {
            fields = match[1].split(', ').map(columnWithTable => columnWithTable.split('.')[1]);
          }
        }

        const errors = [];
        let message = 'Validation error';

        for (const field of fields) {
          errors.push(new sequelizeErrors.ValidationErrorItem(
            this.getUniqueConstraintErrorMessage(field),
            'unique violation', field, this.instance && this.instance[field]));
        }

        if (this.model) {
          _.forOwn(this.model.uniqueKeys, constraint => {
            if (_.isEqual(constraint.fields, fields) && !!constraint.msg) {
              message = constraint.msg;
              return false;
            }
          });
        }

        return new sequelizeErrors.UniqueConstraintError({message, errors, parent: err, fields});
      }
      case 'SQLITE_BUSY':
        return new sequelizeErrors.TimeoutError(err);

      default:
        return new sequelizeErrors.DatabaseError(err);
    }
  }

  handleShowIndexesQuery(data) {

    // Sqlite returns indexes so the one that was defined last is returned first. Lets reverse that!
    return this.sequelize.Promise.map(data.reverse(), item => {
      item.fields = [];
      item.primary = false;
      item.unique = !!item.unique;

      return this.run('PRAGMA INDEX_INFO(`' + item.name + '`)').then(columns => {
        for (const column of columns) {
          item.fields[column.seqno] = {
            attribute: column.name,
            length: undefined,
            order: undefined,
          };
        }

        return item;
      });
    });
  }

  getDatabaseMethod() {
    if (this.isUpsertQuery()) {
      return 'exec'; // Needed to run multiple queries in one
    } else if (this.isInsertQuery() || this.isUpdateQuery() || this.isBulkUpdateQuery() || (this.sql.toLowerCase().indexOf('CREATE TEMPORARY TABLE'.toLowerCase()) !== -1) || this.options.type === QueryTypes.BULKDELETE) {
      return 'run';
    } else {
      return 'all';
    }
  }
}

module.exports = Query;
module.exports.Query = Query;
module.exports.default = Query;
