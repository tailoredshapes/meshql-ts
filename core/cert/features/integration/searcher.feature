Feature: Searcher Contract
  As a database plugin developer
  I want to implement the Searcher interface correctly
  So that MeshQL can query data using Handlebars templates across any database

  Background:
    Given a fresh repository and searcher instance
    And I have created and saved the following test dataset:
      | name     | count | type |
      | Bruce    | 1     | A    |
      | Charlie  | 2     | A    |
      | Danny    | 3     | A    |
      | Ewan     | 4     | A    |
      | Fred     | 5     | B    |
      | Greg     | 6     | B    |
      | Henry    | 7     | B    |
      | Ian      | 8     | B    |
      | Gretchen | 9     | B    |
      | Casie    | 9     | A    |
    And I have removed envelope "Gretchen"
    And I have updated envelope "Casie" to "Cassie" with count 10

  Scenario: Finding a singleton by ID with non-existent ID
    When I search using template "findById" with parameters:
      | id              |
      | non-existent-id |
    Then the search result should be empty

  Scenario: Finding a singleton by ID
    When I search using template "findById" with parameters:
      | id    |
      | Bruce |
    Then the search result should have name "Bruce"
    And the search result should have count 1

  Scenario: Finding a singleton by name
    When I search using template "findByName" with parameters:
      | id   |
      | Ewan |
    Then the search result should have name "Ewan"

  Scenario: Finding all records by type
    When I search all using template "findAllByType" with parameters:
      | id |
      | A  |
    Then I should receive exactly 5 results
    And the results should include an envelope with name "Charlie" and count 2

  Scenario: Finding all records by type and name
    When I search all using template "findByNameAndType" with parameters:
      | name  | type |
      | Henry | B    |
    Then I should receive exactly 1 result
    And the results should include an envelope with name "Henry"

  Scenario: Finding all with non-existent type
    When I search all using template "findAllByType" with parameters:
      | id |
      | C  |
    Then I should receive exactly 0 results

  Scenario: Handling empty query parameters
    When I search all using template "findByNameAndType" with parameters:
      | id  |
      | foo |
    Then I should receive exactly 0 results

  Scenario: Search results carry an opt-in createdAt as-of field
    When I search using template "findById" with parameters:
      | id    |
      | Bruce |
    Then the search result should have a valid createdAt
    When I search all using template "findAllByType" with parameters:
      | id |
      | A  |
    Then every result should have a valid createdAt
