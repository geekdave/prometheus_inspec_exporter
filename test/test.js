const nock = require('nock');
const fixture = require('./fixtures.json');
var chai = require('chai');
var expect = chai.expect;

var app = require('../index');

describe('getProjects', () => {
  beforeEach(() => {
    app.init({
      SNYK_API_TOKEN: 'abc-123',
      ORG_NAME: 'springfield'
    });
  });

  beforeEach(() => {
    nock(
      'https://snyk.io:443')
      .get('/api/v1/org/springfield/projects')
      .reply(200, fixture);
  });

  it('should get the org information', async () => {
    const response = await app.getProjects('springfield');
    expect(response.data.org.name).to.equal('springfield');
    expect(response.data.org.id).to.equal('1234567a-123b-456c-def7-890abcdefg01');
  });

  it('should get the project information', async () => {
    const response = await app.getProjects('springfield');
    expect(response.data.projects.length).to.equal(3);

    expect(response.data.projects[0].name).to.equal('burns');
    expect(response.data.projects[0].id).to.equal('2234567a-123b-456c-def7-890abcdefg01');

    expect(response.data.projects[1].name).to.equal('smithers');
    expect(response.data.projects[1].id).to.equal('3234567a-123b-456c-def7-890abcdefg01');

    expect(response.data.projects[2].name).to.equal('frink');
    expect(response.data.projects[2].id).to.equal('4234567a-123b-456c-def7-890abcdefg01');
  });
});
