Feature: Farm Integration Test
  As a MeshQL user
  I want to verify the farm example works end-to-end
  So that I can see GraphQL resolvers working across multiple databases

  Background:
    Given the farm service is running in Docker
    And I have created the REST API clients
    And I have populated the farm data

  Scenario: Query farm with nested coops and hens
    When I query the farm graph with:
      """
      {
        getById(id: "${farm_id}") {
          name
          coops {
            name
            hens {
              name
            }
          }
        }
      }
      """
    Then the farm name should be "Emerdale"
    And there should be 3 coops
