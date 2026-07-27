Feature: Authorization Certification
  As a database plugin developer
  I want authorization enforced on every read and write path
  So that a credentialed caller only ever reaches the records their credentials entitle them to

  # Every scenario drives the real HTTP surfaces — writes through the restlette,
  # reads through the graphlette — because every defect this suite exists to catch
  # lives in the wiring ABOVE the Searcher. A repository-level suite cannot see them.
  #
  # Callers and the credentials their JWT resolves to (see config/casbin/policy.csv):
  #   alice  -> ["tenant_a"]
  #   bob    -> ["tenant_b"]
  #   root   -> ["tenant_a", "tenant_b"]
  #   nobody -> []

  Background:
    Given an authorization-enabled MeshQL server is running with the plugin

  Scenario: A credentialed write persists the caller's tokens
    When "alice" creates a hen named "audit-bird"
    Then the stored envelope should have authorized tokens "tenant_a"

  Scenario: A record is readable by its owner and invisible to another caller
    Given "alice" has created a hen named "alice-only"
    When "alice" queries the graph by id for "alice-only"
    Then the singleton result should be the hen "alice-only"
    When "bob" queries the graph by id for "alice-only"
    Then the singleton result should be empty

  Scenario: A list query returns only the caller's own records
    Given "alice" has created a hen named "flock-bird"
    And "bob" has created a hen named "flock-bird"
    When "alice" queries the graph by name "flock-bird"
    Then the vector result should contain exactly 1 hen
    And the vector result should be owned by "alice"
    When "bob" queries the graph by name "flock-bird"
    Then the vector result should contain exactly 1 hen
    And the vector result should be owned by "bob"

  Scenario: A record written without credentials is public
    Given "nobody" has created a hen named "public-bird"
    Then the stored envelope should have no authorized tokens
    When "alice" queries the graph by id for "public-bird"
    Then the singleton result should be the hen "public-bird"
    When "bob" queries the graph by id for "public-bird"
    Then the singleton result should be the hen "public-bird"

  Scenario: A caller holding every token still sees everything
    When "root" queries the graph by name "flock-bird"
    Then the vector result should contain exactly 2 hens

  Scenario: Delete honours tokens
    Given "alice" has created a hen named "doomed-bird"
    When "bob" deletes the hen "doomed-bird" created by "alice"
    Then the response status should be 403
    And "alice" should still be able to read the hen "doomed-bird"
    When "alice" deletes the hen "doomed-bird" created by "alice"
    Then the response status should be 200

  Scenario: Rewinding time does not rewind authorization
    Given "alice" has created a hen named "time-bird"
    And I capture the current time
    When "alice" queries the graph by id for "time-bird" as of the captured time
    Then the singleton result should be the hen "time-bird"
    When "bob" queries the graph by id for "time-bird" as of the captured time
    Then the singleton result should be empty
